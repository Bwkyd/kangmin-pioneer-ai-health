// 此文件由 scripts/write-miniprogram-questionnaire.mjs 生成；题面正本只在 assessment-questionnaire.ts。
var FIELD_TO_QUESTION = {
  "q1": "q1",
  "q2": "q2",
  "q3": "q3",
  "q4": "q4",
  "q5": "q5",
  "q6": "q6",
  "q7": "q7",
  "q8": "q8",
  "q9": "q9",
  "q10": "q10",
  "q11": "q11",
  "q12": "q12",
  "q13": "q13",
  "q14": "q14",
  "paroxysmal_sneezing": "q1",
  "watery_rhinorrhea": "q2",
  "nasal_congestion": "q3",
  "nasal_itching": "q4",
  "fear_wind": "q6",
  "fatigue": "q8",
  "limbs_not_warm": "q9",
  "thirst": "q10",
  "heat_imbalance": "q11",
  "step1_q10": "q10",
  "step2_q8": "q8",
  "step3_q6": "q6",
  "step4_q9": "q9",
  "step5_q8_confirm": "q8",
  "step6_q10_confirm": "q10"
};
var QUESTIONS = [
  {
    "id": "q1",
    "title": "您打喷嚏的情况是？",
    "options": [
      {
        "code": "A",
        "text": "频繁打喷嚏，一次连续数个至十几个"
      },
      {
        "code": "B",
        "text": "偶尔打喷嚏"
      },
      {
        "code": "C",
        "text": "基本不打喷嚏"
      }
    ]
  },
  {
    "id": "q2",
    "title": "您的鼻涕通常是？",
    "options": [
      {
        "code": "A",
        "text": "清水样，量多，像水一样流下来"
      },
      {
        "code": "B",
        "text": "白黏鼻涕"
      },
      {
        "code": "C",
        "text": "黄稠鼻涕"
      },
      {
        "code": "D",
        "text": "鼻涕很少，鼻腔干燥"
      }
    ]
  },
  {
    "id": "q3",
    "title": "您的鼻塞情况是？",
    "options": [
      {
        "code": "A",
        "text": "双侧都堵，持续不通"
      },
      {
        "code": "B",
        "text": "左右交替鼻塞"
      },
      {
        "code": "C",
        "text": "发作时才堵，不发作时正常"
      },
      {
        "code": "D",
        "text": "基本不鼻塞"
      }
    ]
  },
  {
    "id": "q4",
    "title": "您的鼻痒程度？",
    "options": [
      {
        "code": "A",
        "text": "明显鼻痒，经常忍不住揉鼻子"
      },
      {
        "code": "B",
        "text": "轻微鼻痒"
      },
      {
        "code": "C",
        "text": "不痒"
      }
    ]
  },
  {
    "id": "q5",
    "title": "您的鼻炎在什么情况下容易发作或加重？",
    "options": [
      {
        "code": "A",
        "text": "遇到冷空气、吹风或天冷时加重"
      },
      {
        "code": "B",
        "text": "接触花粉、尘螨等过敏原时发作"
      },
      {
        "code": "C",
        "text": "晨起时发作明显"
      },
      {
        "code": "D",
        "text": "无明显规律"
      }
    ]
  },
  {
    "id": "q6",
    "title": "您是否比别人更怕风、怕冷？",
    "options": [
      {
        "code": "A",
        "text": "明显怕风怕冷，比别人穿得多"
      },
      {
        "code": "B",
        "text": "稍微有一点"
      },
      {
        "code": "C",
        "text": "不怕"
      }
    ]
  },
  {
    "id": "q7",
    "title": "您是否容易感冒？",
    "options": [
      {
        "code": "A",
        "text": "经常感冒，一年好几次"
      },
      {
        "code": "B",
        "text": "偶尔感冒"
      },
      {
        "code": "C",
        "text": "很少感冒"
      }
    ]
  },
  {
    "id": "q8",
    "title": "您是否经常感觉疲倦、没力气？",
    "options": [
      {
        "code": "A",
        "text": "经常觉得累，什么都不想做"
      },
      {
        "code": "B",
        "text": "偶尔有"
      },
      {
        "code": "C",
        "text": "没有"
      }
    ]
  },
  {
    "id": "q9",
    "title": "您的手脚是否经常冰凉？",
    "options": [
      {
        "code": "A",
        "text": "一年四季手脚都凉"
      },
      {
        "code": "B",
        "text": "天气冷的时候会凉"
      },
      {
        "code": "C",
        "text": "手脚总是暖和的"
      }
    ]
  },
  {
    "id": "q10",
    "title": "您是否经常感觉口干、想喝水？",
    "options": [
      {
        "code": "A",
        "text": "经常口干，想喝凉的"
      },
      {
        "code": "B",
        "text": "偶尔口干"
      },
      {
        "code": "C",
        "text": "不觉得口干"
      }
    ]
  },
  {
    "id": "q11",
    "title": "以下哪项最符合您的日常感觉？",
    "options": [
      {
        "code": "A",
        "text": "怕冷，手脚凉，腰膝酸软，夜尿多"
      },
      {
        "code": "B",
        "text": "怕热，手心脚心发热，口干咽燥"
      },
      {
        "code": "C",
        "text": "容易过敏，皮肤痒，喷嚏频繁"
      },
      {
        "code": "D",
        "text": "以上都不明显"
      }
    ]
  },
  {
    "id": "q12",
    "title": "最近 1 周，您的鼻痒、打喷嚏、流鼻涕、鼻塞等鼻部症状发作情况是？",
    "options": [
      {
        "code": "A",
        "text": "几乎每天都有明显症状，影响日常生活"
      },
      {
        "code": "B",
        "text": "偶尔发作，但能忍受"
      },
      {
        "code": "C",
        "text": "基本没有，或只有轻微感觉，不影响生活"
      }
    ]
  },
  {
    "id": "q13",
    "title": "您目前最迫切想解决的问题是？",
    "options": [
      {
        "code": "A",
        "text": "马上缓解鼻塞、流涕、打喷嚏等难受症状"
      },
      {
        "code": "B",
        "text": "调理体质，减少以后复发"
      }
    ]
  },
  {
    "id": "q14",
    "title": "您的症状发作时，通常属于以下哪种模式？",
    "options": [
      {
        "code": "A",
        "text": "突然发作，症状较重，但发作间期基本正常"
      },
      {
        "code": "B",
        "text": "长期处于“似好非好”状态，不严重但一直没好利索"
      }
    ]
  }
];

function questionForField(fieldCode) {
  var id = FIELD_TO_QUESTION[fieldCode];
  for (var index = 0; index < QUESTIONS.length; index += 1) {
    if (QUESTIONS[index].id === id) return QUESTIONS[index];
  }
  return null;
}

function view(item) {
  var question = questionForField(item.fieldCode);
  if (question) {
    return { fieldCode: item.fieldCode, title: question.title, options: question.options.map(function (option) {
      return { code: option.code, text: option.text, value: question.id + "=" + option.code };
    }) };
  }
  return { fieldCode: item.fieldCode, title: item.prompt, options: [
    { code: "是", text: "是", value: item.fieldCode + "=yes" },
    { code: "否", text: "否", value: item.fieldCode + "=no" },
    { code: "？", text: "不清楚", value: item.fieldCode + "=unknown" }
  ] };
}

function visibleAnswer(value) {
  var match = /^(q\d+)=([A-D])$/i.exec(String(value || "").trim());
  if (!match) return "";
  for (var index = 0; index < QUESTIONS.length; index += 1) {
    if (QUESTIONS[index].id !== match[1].toLowerCase()) continue;
    for (var optionIndex = 0; optionIndex < QUESTIONS[index].options.length; optionIndex += 1) {
      var option = QUESTIONS[index].options[optionIndex];
      if (option.code === match[2].toUpperCase()) return option.text;
    }
  }
  return "";
}

module.exports = { view: view, visibleAnswer: visibleAnswer, questions: QUESTIONS };
