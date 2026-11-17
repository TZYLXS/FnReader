import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 无第三方依赖的 FnReader 本机 TOC worker。
 * Java 21 使用虚拟线程；旧 JDK 仅用于开发机兼容测试，回退 cached pool。
 * 协议为 NDJSON 风格的 Base64 三列文本，避免在 FPK 中引入 JSON jar。
 */
public final class FnReaderJavaWorker {
    private static final Pattern NUMBER = Pattern.compile("第\\s*([零一二三四五六七八九十百千万两\\d]+)\\s*[章节回卷]");
    private static final Pattern LOOKS_CHAPTER = Pattern.compile("^\\s*第\\s*[零一二三四五六七八九十百千万两\\d]+\\s*[章节回卷]");
    private static final Map<Character, Integer> DIGITS = Map.ofEntries(
            Map.entry('零', 0), Map.entry('一', 1), Map.entry('二', 2), Map.entry('两', 2),
            Map.entry('三', 3), Map.entry('四', 4), Map.entry('五', 5), Map.entry('六', 6),
            Map.entry('七', 7), Map.entry('八', 8), Map.entry('九', 9));
    private static final Map<Character, Integer> UNITS = Map.of('十', 10, '百', 100, '千', 1000, '万', 10000);
    private static volatile boolean virtualThreads;

    record Chapter(String url, String title, int index, int order) {}

    public static void main(String[] args) throws Exception {
        ExecutorService executor;
        boolean virtual = false;
        try {
            executor = (ExecutorService) Executors.class.getMethod("newVirtualThreadPerTaskExecutor").invoke(null);
            virtual = true;
        } catch (ReflectiveOperationException ignored) {
            executor = Executors.newCachedThreadPool();
        }
        virtualThreads = virtual;
        final ExecutorService shutdownExecutor = executor;
        HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.setExecutor(executor);
        server.createContext("/health", exchange -> respond(exchange, 200, "application/json; charset=utf-8",
                ("{\"ok\":true,\"java\":\"" + Runtime.version() + "\",\"virtualThreads\":" + virtualThreads + "}").getBytes(StandardCharsets.UTF_8)));
        server.createContext("/toc/normalize", FnReaderJavaWorker::handleToc);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            server.stop(0);
            shutdownExecutor.shutdownNow();
        }));
        server.start();
        System.out.println("PORT=" + server.getAddress().getPort());
        System.out.flush();
    }

    private static void handleToc(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            respond(exchange, 405, "text/plain; charset=utf-8", "POST required".getBytes(StandardCharsets.UTF_8));
            return;
        }
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(exchange.getRequestBody(), StandardCharsets.UTF_8))) {
            List<Chapter> input = new ArrayList<>();
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) continue;
                if (input.size() >= 100000) throw new IllegalArgumentException("too many chapters");
                String[] columns = line.split("\\t", -1);
                if (columns.length != 3) throw new IllegalArgumentException("invalid chapter line");
                input.add(new Chapter(decode(columns[0]), decode(columns[1]), Integer.parseInt(columns[2]), input.size()));
            }
            List<Chapter> result = normalize(input);
            StringBuilder body = new StringBuilder();
            for (Chapter chapter : result) {
                body.append(encode(chapter.url())).append('\t').append(encode(chapter.title()))
                        .append('\t').append(chapter.index()).append('\n');
            }
            respond(exchange, 200, "application/x-ndjson; charset=utf-8", body.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            String message = String.valueOf(e.getMessage()).replace('\n', ' ').replace('\r', ' ');
            respond(exchange, 400, "text/plain; charset=utf-8", message.getBytes(StandardCharsets.UTF_8));
        }
    }

    static List<Chapter> normalize(List<Chapter> chapters) {
        if (chapters.size() < 2) return chapters;
        Set<String> seenUrl = new HashSet<>();
        Set<String> seenTitle = new HashSet<>();
        List<Chapter> deduped = new ArrayList<>();
        for (Chapter chapter : chapters) {
            String url = chapter.url().trim();
            String title = chapter.title().trim().replaceAll("\\s+", "");
            if ((!url.isEmpty() && seenUrl.contains(url)) || (!title.isEmpty() && seenTitle.contains(title))) continue;
            if (!url.isEmpty()) seenUrl.add(url);
            if (!title.isEmpty()) seenTitle.add(title);
            deduped.add(chapter);
        }
        long standard = deduped.stream().filter(c -> LOOKS_CHAPTER.matcher(c.title()).find()).count();
        List<Chapter> filtered = standard >= deduped.size() * 0.7
                ? deduped.stream().filter(c -> LOOKS_CHAPTER.matcher(c.title()).find()).toList() : deduped;
        List<Integer> numbers = filtered.stream().map(c -> chapterNumber(c.title())).toList();
        long known = numbers.stream().filter(n -> n > 0).count();
        if (known < filtered.size() * 0.6) return filtered;
        List<Chapter> sorted = new ArrayList<>(filtered);
        sorted.sort(Comparator.<Chapter>comparingLong(c -> {
            int n = chapterNumber(c.title());
            return n > 0 ? n : Long.MAX_VALUE;
        }).thenComparingInt(Chapter::order));
        return sorted;
    }

    static int chapterNumber(String title) {
        Matcher matcher = NUMBER.matcher(normalizeCircled(title));
        if (!matcher.find()) return 0;
        String raw = matcher.group(1);
        if (raw.chars().allMatch(Character::isDigit)) return Integer.parseInt(raw);
        return cnToNumber(raw);
    }

    static int cnToNumber(String text) {
        int total = 0, section = 0, number = 0;
        for (int offset = 0; offset < text.length();) {
            char ch = text.charAt(offset++);
            if (ch >= '0' && ch <= '9') number = number * 10 + ch - '0';
            else if (DIGITS.containsKey(ch)) number = DIGITS.get(ch);
            else if (UNITS.containsKey(ch)) {
                int unit = UNITS.get(ch);
                if (unit == 10000) {
                    section = (section + number) * unit;
                    total += section;
                    section = 0;
                } else section += (number == 0 ? 1 : number) * unit;
                number = 0;
            }
        }
        return total + section + number;
    }

    static String normalizeCircled(String text) {
        StringBuilder result = new StringBuilder();
        text.codePoints().forEach(code -> {
            if (code >= 0x2460 && code <= 0x2473) result.append(code - 0x2460 + 1);
            else if (code >= 0x3251 && code <= 0x325f) result.append(code - 0x3251 + 21);
            else result.appendCodePoint(code);
        });
        return result.toString();
    }

    private static String encode(String value) {
        return Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static String decode(String value) {
        return new String(Base64.getDecoder().decode(value), StandardCharsets.UTF_8);
    }

    private static void respond(HttpExchange exchange, int status, String type, byte[] body) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", type);
        exchange.sendResponseHeaders(status, body.length);
        try (OutputStream output = exchange.getResponseBody()) { output.write(body); }
    }
}
