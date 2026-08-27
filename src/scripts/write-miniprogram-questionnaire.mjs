import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { FIELD_TO_QUESTION } from "../dist/modules/agent/option-mapping.js";
import { ASSESSMENT_QUESTIONS } from "../dist/modules/clinical-rules/assessment-questionnaire.js";

const output = `// 此文件由 scripts/write-miniprogram-questionnaire.mjs 生成；题面正本只在 assessment-questionnaire.ts。\n` +
  `var FIELD_TO_QUESTION = ${JSON.stringify(FIELD_TO_QUESTION, null, 2)};\n` +
  `var QUESTIONS = ${JSON.stringify(ASSESSMENT_QUESTIONS, null, 2)};\n\n` +
  `function questionForField(fieldCode) {\n` +
  `  var id = FIELD_TO_QUESTION[fieldCode];\n` +
  `  for (var index = 0; index < QUESTIONS.length; index += 1) {\n` +
  `    if (QUESTIONS[index].id === id) return QUESTIONS[index];\n` +
  `  }\n` +
  `  return null;\n` +
  `}\n\n` +
  `function view(item) {\n` +
  `  var question = questionForField(item.fieldCode);\n` +
  `  if (question) {\n` +
  `    return { fieldCode: item.fieldCode, title: question.title, options: question.options.map(function (option) {\n` +
  `      return { code: option.code, text: option.text, value: question.id + "=" + option.code };\n` +
  `    }) };\n` +
  `  }\n` +
  `  return { fieldCode: item.fieldCode, title: item.prompt, options: [\n` +
  `    { code: "是", text: "是", value: item.fieldCode + "=yes" },\n` +
  `    { code: "否", text: "否", value: item.fieldCode + "=no" },\n` +
  `    { code: "？", text: "不清楚", value: item.fieldCode + "=unknown" }\n` +
  `  ] };\n` +
  `}\n\n` +
  `function visibleAnswer(value) {\n` +
  `  var match = /^(q\\d+)=([A-D])$/i.exec(String(value || "").trim());\n` +
  `  if (!match) return "";\n` +
  `  for (var index = 0; index < QUESTIONS.length; index += 1) {\n` +
  `    if (QUESTIONS[index].id !== match[1].toLowerCase()) continue;\n` +
  `    for (var optionIndex = 0; optionIndex < QUESTIONS[index].options.length; optionIndex += 1) {\n` +
  `      var option = QUESTIONS[index].options[optionIndex];\n` +
  `      if (option.code === match[2].toUpperCase()) return option.text;\n` +
  `    }\n` +
  `  }\n` +
  `  return "";\n` +
  `}\n\nmodule.exports = { view: view, visibleAnswer: visibleAnswer, questions: QUESTIONS };\n`;

writeFileSync(resolve("apps/kangmin-miniprogram/src/utils/questionnaire.js"), output, "utf8");
