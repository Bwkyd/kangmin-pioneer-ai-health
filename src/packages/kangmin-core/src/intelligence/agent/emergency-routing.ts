/** 明确急症只做确定性前置分流，不交给模型决定是否继续普通问答。 */
export function isEmergencyMessage(message: string): boolean {
  return /呼吸困难|喘不上气|胸闷憋气|口唇发紫|嘴唇发紫|意识不清|意识异常|昏迷|剧烈胸痛/u.test(message);
}

export const EMERGENCY_KNOWLEDGE_ANSWER =
  "请立即联系急救或前往急诊。胸闷、喘不上气、嘴唇发紫、意识异常或剧烈胸痛都可能危及生命，不要继续等待或自行驾车。";
