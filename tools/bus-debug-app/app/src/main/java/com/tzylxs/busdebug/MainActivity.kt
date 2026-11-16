package com.tzylxs.busdebug

import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.concurrent.thread

/**
 * 软总线调试工具：
 *  - 手动连接服务端（填地址 + token）
 *  - 长轮询领取任务，可视化展示 search / toc / content / bookinfo / ebook-parse
 *  - 可手工编辑并回传结果，也可手动向服务端下发任务
 */
class MainActivity : Activity() {

    private lateinit var etBase: EditText
    private lateinit var etToken: EditText
    private lateinit var etDeviceId: EditText
    private lateinit var etDeviceName: EditText
    private lateinit var tvLog: TextView
    private lateinit var tvStatus: TextView
    private lateinit var btnPoll: Button
    private lateinit var btnConnect: Button

    private val ui = Handler(Looper.getMainLooper())
    private val prefs by lazy { getSharedPreferences("bus-debug", MODE_PRIVATE) }
    private val timeFmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.getDefault())

    @Volatile private var polling = false
    private var pollThread: Thread? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        loadPrefs()
        setPollingState(false)
        log("软总线调试工具已启动。先填写服务端地址与访问令牌，然后点「连接」。")
    }

    // ---------------- UI ----------------

    private fun buildUi(): ViewGroup {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(8))
        }

        root.addView(TextView(this).apply {
            text = "软总线调试"
            textSize = 22f
            setPadding(0, 0, 0, dp(8))
        })

        etBase = input(root, "服务端地址", "http://10.5.4.70:1122")
        etToken = input(root, "访问令牌 X-Api-Token", "")
        etDeviceId = input(root, "设备 ID", "bus-debug-01")
        etDeviceName = input(root, "设备名", "调试机")

        val row1 = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        btnConnect = button(row1, "连接") { onConnect() }
        button(row1, "总线状态") { onShowBus() }
        button(row1, "清空") { tvLog.text = "" }
        root.addView(row1)

        val row2 = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        btnPoll = button(row2, "开始轮询") { togglePolling() }
        button(row2, "下发搜索") { onManualJob("search") }
        button(row2, "下发目录") { onManualJob("toc") }
        root.addView(row2)

        val row3 = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        button(row3, "下发正文") { onManualJob("content") }
        button(row3, "下发详情") { onManualJob("bookinfo") }
        button(row3, "导出日志") { exportLog() }
        root.addView(row3)

        tvStatus = TextView(this).apply {
            text = "未连接"
            textSize = 12f
            setPadding(0, dp(6), 0, dp(6))
        }
        root.addView(tvStatus)

        val scroll = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f
            )
        }
        tvLog = TextView(this).apply {
            textSize = 12f
            typeface = android.graphics.Typeface.MONOSPACE
            setTextIsSelectable(true)
            setPadding(dp(8), dp(8), dp(8), dp(8))
        }
        scroll.addView(tvLog)
        root.addView(scroll)

        return root
    }

    private fun input(parent: LinearLayout, hint: String, def: String): EditText {
        val label = TextView(this).apply {
            text = hint
            textSize = 12f
            setPadding(0, dp(6), 0, 0)
        }
        parent.addView(label)
        val et = EditText(this).apply {
            this.hint = hint
            setText(def)
            textSize = 14f
            inputType = InputType.TYPE_CLASS_TEXT
            setSingleLine(true)
        }
        parent.addView(et)
        return et
    }

    private fun button(parent: LinearLayout, text: String, onClick: () -> Unit): Button {
        val b = Button(this).apply {
            this.text = text
            textSize = 13f
            setOnClickListener { onClick() }
        }
        parent.addView(b, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        return b
    }

    private fun dp(v: Int): Int = (resources.displayMetrics.density * v).toInt()

    // ---------------- 配置 ----------------

    private fun loadPrefs() {
        etBase.setText(prefs.getString("base", "http://10.5.4.70:1122"))
        etToken.setText(prefs.getString("token", ""))
        etDeviceId.setText(prefs.getString("deviceId", "bus-debug-01"))
        etDeviceName.setText(prefs.getString("deviceName", "调试机"))
    }

    private fun savePrefs() {
        prefs.edit()
            .putString("base", baseUrl())
            .putString("token", token())
            .putString("deviceId", deviceId())
            .putString("deviceName", deviceName())
            .apply()
    }

    private fun baseUrl(): String = etBase.text.toString().trim().trimEnd('/')
    private fun token(): String = etToken.text.toString().trim()
    private fun deviceId(): String = etDeviceId.text.toString().trim().ifBlank { "bus-debug" }
    private fun deviceName(): String = etDeviceName.text.toString().trim().ifBlank { "调试机" }

    // ---------------- 网络 ----------------

    private fun http(
        method: String,
        path: String,
        body: String? = null,
        withToken: Boolean = true,
        timeoutMs: Int = 35000
    ): Pair<Int, String> {
        val url = URL(baseUrl() + path)
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 8000
        conn.readTimeout = timeoutMs
        conn.setRequestProperty("Accept", "application/json")
        if (withToken && token().isNotEmpty()) conn.setRequestProperty("X-Api-Token", token())
        if (body != null) {
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        }
        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.use { s ->
            BufferedReader(InputStreamReader(s, Charsets.UTF_8)).readText()
        } ?: ""
        conn.disconnect()
        return code to text
    }

    private fun log(msg: String) {
        val line = "[${timeFmt.format(Date())}] $msg\n"
        ui.post {
            tvLog.append(line)
            (tvLog.parent as? ScrollView)?.fullScroll(ScrollView.FOCUS_DOWN)
        }
    }

    private fun setStatus(text: String) {
        ui.post { tvStatus.text = text }
    }

    private fun toast(msg: String) {
        ui.post { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show() }
    }

    // ---------------- 操作 ----------------

    private fun onConnect() {
        savePrefs()
        thread {
            try {
                val (code, text) = http("GET", "/api/bus")
                log("GET /api/bus -> $code")
                if (code == 200) {
                    setStatus("已连接：${baseUrl()}")
                    val j = JSONObject(text)
                    val devices = j.optJSONArray("devices") ?: JSONArray()
                    val names = (0 until devices.length()).mapNotNull { i ->
                        val d = devices.optJSONObject(i) ?: return@mapNotNull null
                        "${d.optString("name")}(${if (d.optBoolean("online")) "online" else "offline"}, handled=${d.optInt("handled")})"
                    }
                    log("设备: " + if (names.isEmpty()) "无" else names.joinToString(" | "))
                    log("待处理任务: " + j.optInt("pending"))
                } else {
                    setStatus("连接失败（$code）")
                    log(text.take(300))
                }
            } catch (e: Exception) {
                setStatus("连接异常")
                log("连接失败: ${e.message}")
            }
        }
    }

    private fun onShowBus() {
        thread {
            try {
                val (code, text) = http("GET", "/api/bus")
                log("GET /api/bus -> $code\n${pretty(text)}")
            } catch (e: Exception) {
                log("读取总线状态失败: ${e.message}")
            }
        }
    }

    private fun togglePolling() {
        if (polling) {
            polling = false
            setPollingState(false)
            log("已停止轮询")
            return
        }
        savePrefs()
        polling = true
        setPollingState(true)
        log("开始轮询任务（设备 ${deviceId()} / ${deviceName()}）")
        pollThread = thread(name = "bus-poll") {
            while (polling) {
                try {
                    pollOnce()
                } catch (e: Exception) {
                    log("轮询异常: ${e.message}")
                    Thread.sleep(3000)
                }
            }
        }
    }

    private fun setPollingState(on: Boolean) {
        ui.post {
            btnPoll.text = if (on) "停止轮询" else "开始轮询"
            btnPoll.setBackgroundColor(if (on) 0xFFE57373.toInt() else 0x00000000)
        }
    }

    private fun pollOnce() {
        val q = "?token=${enc(token())}&wait=10000&limit=5&id=${enc(deviceId())}&name=${enc(deviceName())}"
        val (code, text) = http("GET", "/api/m/remote/pending$q", timeoutMs = 30000)
        if (code == 409) {
            log("409：服务端要求先确认缓存位置（网页端设置 → 完成安装确认），30 秒后重试")
            Thread.sleep(30000)
            return
        }
        if (code != 200) {
            log("pending -> $code ${text.take(200)}")
            Thread.sleep(2000)
            return
        }
        val jobs = JSONObject(text).optJSONArray("jobs") ?: return
        if (jobs.length() == 0) return
        for (i in 0 until jobs.length()) {
            val job = jobs.optJSONObject(i) ?: continue
            val id = job.optString("id")
            val type = job.optString("type")
            val payload = job.optJSONObject("payload") ?: JSONObject()
            log("领取任务 id=$id type=$type age=${job.optInt("age")}ms\npayload: ${payload}")
            ui.post { showJobDialog(id, type, payload) }
        }
    }

    /** 任务弹窗：可视化 payload，可编辑回传数据 */
    private fun showJobDialog(jobId: String, type: String, payload: JSONObject) {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(8), dp(16), dp(8))
        }
        box.addView(TextView(this).apply {
            text = "任务 $type\nid=$jobId"
            textSize = 14f
        })
        box.addView(TextView(this).apply {
            text = "payload："
            textSize = 12f
        })
        val etPayload = EditText(this).apply {
            setText(pretty(payload.toString()))
            textSize = 12f
            typeface = android.graphics.Typeface.MONOSPACE
            minLines = 3
            maxLines = 8
            setTextIsSelectable(true)
        }
        box.addView(etPayload)
        box.addView(TextView(this).apply {
            text = "回传 data（成功时提交这段 JSON）："
            textSize = 12f
        })
        val etData = EditText(this).apply {
            setText(defaultData(type))
            textSize = 12f
            typeface = android.graphics.Typeface.MONOSPACE
            minLines = 4
            maxLines = 10
        }
        box.addView(etData)
        box.addView(TextView(this).apply {
            text = "失败原因（可选）："
            textSize = 12f
        })
        val etError = EditText(this).apply {
            hint = "解析失败原因"
            textSize = 12f
            setSingleLine(true)
        }
        box.addView(etError)

        val dialog = AlertDialog.Builder(this)
            .setTitle("软总线任务")
            .setView(ScrollView(this).apply { addView(box) })
            .setPositiveButton("回传成功") { _, _ -> reply(jobId, true, etData.text.toString(), null) }
            .setNegativeButton("回传失败") { _, _ ->
                reply(jobId, false, null, etError.text.toString().ifBlank { "调试工具标记失败" })
            }
            .setNeutralButton("忽略") { _, _ -> log("忽略任务 $jobId（服务端会超时）") }
            .create()
        dialog.show()
    }

    private fun defaultData(type: String): String = when (type) {
        "search" -> """{"books":[]}"""
        "toc" -> """{"chapters":[]}"""
        "content" -> """{"paragraphs":["调试内容"]}"""
        "bookinfo" -> """{"intro":"","coverUrl":"","author":"","lastChapter":""}"""
        "ebook-parse" -> """{"chapters":[]}"""
        "ebook-chapter" -> """{"paragraphs":[]}"""
        else -> "{}"
    }

    private fun reply(jobId: String, ok: Boolean, data: String?, error: String?) {
        thread {
            try {
                val body = JSONObject().apply {
                    put("id", jobId)
                    put("ok", ok)
                    if (ok) put("data", JSONObject(data ?: "{}")) else put("error", error ?: "调试失败")
                    put("deviceId", deviceId())
                }
                val (code, text) = http(
                    "POST",
                    "/api/m/remote/result?token=${enc(token())}",
                    body.toString()
                )
                log("回传 $jobId ok=$ok -> $code ${text.take(160)}")
            } catch (e: Exception) {
                log("回传失败: ${e.message}")
            }
        }
    }

    /** 手动向服务端下发任务（模拟网页端发起） */
    private fun onManualJob(type: String) {
        savePrefs()
        val prefill = when (type) {
            "search" -> """{"source":"http://www.qiushu.info","key":"深海提督"}"""
            "toc" -> """{"source":"http://www.qiushu.info","bookUrl":"http://www.qiushu.info/t/56006/"}"""
            "content" -> """{"source":"http://www.qiushu.info","chapterUrl":"","bookUrl":""}"""
            else -> """{"bookUrl":""}"""
        }
        val et = EditText(this).apply {
            setText(prefill)
            textSize = 12f
            typeface = android.graphics.Typeface.MONOSPACE
            minLines = 3
        }
        AlertDialog.Builder(this)
            .setTitle("下发 $type 任务（payload JSON）")
            .setView(ScrollView(this).apply { addView(et) })
            .setPositiveButton("下发") { _, _ ->
                thread {
                    try {
                        val payload = JSONObject(et.text.toString())
                        val body = JSONObject().apply {
                            put("type", type)
                            put("payload", payload)
                            put("waitMs", 20000)
                        }
                        val (code, text) = http("POST", "/api/remote/job", body.toString())
                        log("下发 $type -> $code\n${pretty(text).take(1500)}")
                    } catch (e: Exception) {
                        log("下发失败: ${e.message}")
                    }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun exportLog() {
        val text = tvLog.text.toString()
        if (text.isBlank()) return toast("日志为空")
        val file = java.io.File(getExternalFilesDir(null), "bus-debug-${System.currentTimeMillis()}.txt")
        try {
            file.writeText(text)
            log("日志已保存：${file.absolutePath}")
            toast("已保存到 ${file.absolutePath}")
        } catch (e: Exception) {
            toast("保存失败：${e.message}")
        }
    }

    // ---------------- 工具 ----------------

    private fun enc(s: String): String =
        URLEncoder.encode(s, "UTF-8")

    private fun pretty(json: String): String = try {
        val t = json.trim()
        when {
            t.startsWith("{") -> JSONObject(t).toString(2)
            t.startsWith("[") -> JSONArray(t).toString(2)
            else -> json
        }
    } catch (e: Exception) {
        json
    }
}
