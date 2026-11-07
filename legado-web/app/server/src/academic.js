'use strict';
// 学术关键词识别：命中则只搜「学术」类书源，跳过网络小说源

const PATTERNS = [
  // 强特征短语（命中即基本可判定）
  { re: /机器学习|深度学习|神经网络|自然语言处理|计算机视觉|强化学习|知识图谱|大语言模型/g, w: 3 },
  { re: /machine learning|deep learning|neural network|natural language processing|computer vision|large language model/gi, w: 3 },

  // 学术场景高频词
  {
    re: /论文|文献|期刊|学报|综述|实证|算法|模型|数据集|实验|假设|显著性|相关性|引用|摘要|学位|科研|学术|课题|样本|变量|回归|分类器|语料/g,
    w: 2,
  },
  {
    re: /\b(algorithm|algorithms|dataset|datasets|hypothesis|empirical|methodology|literature review|preprint|arxiv|citation|abstract|regression|classification|clustering|corpus|benchmark)\b/gi,
    w: 2,
  },

  // 一般研究用词（单独出现不算）
  { re: /\b(paper|journal|survey|study|analysis|model|experiment|research)\b/gi, w: 1 },
];

/**
 * @returns {{academic:boolean, score:number, hits:string[]}}
 */
function detectAcademic(text) {
  const raw = String(text || '').trim();
  if (!raw) return { academic: false, score: 0, hits: [] };

  let score = 0;
  const hits = [];
  for (const { re, w } of PATTERNS) {
    re.lastIndex = 0;
    const found = raw.match(re);
    if (!found) continue;
    score += w * Math.min(found.length, 2);
    for (const f of found) {
      const key = String(f).toLowerCase();
      if (!hits.includes(key)) hits.push(key);
    }
  }

  return { academic: score >= 2, score, hits: hits.slice(0, 4) };
}

module.exports = { detectAcademic };
