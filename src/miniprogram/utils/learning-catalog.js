// 与 Web 学一学目录保持同一套患者可见分类；目录只负责查找已发布内容，
// 不参与证型、诊断或调理规则判断。
var LEARNING_CATALOGS = [
  {
    id: "adult",
    label: "成人方案",
    sections: [
      { id: "adult-quick", label: "快速通窍方案", categories: [{ id: "adult-quick-content", label: "快速通窍方案", aliases: ["成人快速通窍方案", "成人快速通窍", "快速通窍方案"], titles: ["鼻三线姜刮", "姜行通窍", "迎香穴", "指腹擦迎香"] }] },
      { id: "adult-conditioning", label: "调体方案", categories: [
        { id: "adult-lung-qi-cold", label: "肺气虚寒", aliases: ["肺气虚寒"], titles: ["肺俞穴", "耳穴过敏区", "身柱穴", "风门", "大椎穴", "中府", "云门", "耳穴压豆"] },
        { id: "adult-spleen-qi", label: "脾气虚弱", aliases: ["脾气虚弱"], titles: ["天枢穴", "足三里穴", "耳穴过敏区", "耳穴压豆"] },
        { id: "adult-kidney-yang", label: "肾阳不足", aliases: ["肾阳不足"], titles: ["身柱穴", "大椎穴", "耳穴过敏区", "耳穴压豆"] },
        { id: "adult-lung-heat", label: "肺经伏热", aliases: ["肺经伏热"], titles: ["肺俞穴", "耳穴过敏区", "耳穴压豆"] },
        { id: "adult-mixed", label: "寒热错杂", aliases: ["寒热错杂", "虚实并见"], titles: ["肺俞穴", "风门", "大椎穴", "耳穴过敏区"] }
      ] },
      { id: "adult-symptom", label: "按症状分类", categories: [
        { id: "adult-cough", label: "伴咳嗽", aliases: ["过敏性鼻炎伴咳嗽", "伴咳嗽"], titles: ["天突", "膻中", "尺泽", "刮痧法"] },
        { id: "adult-headache", label: "伴头痛", aliases: ["过敏性鼻炎伴头痛", "伴头痛"], titles: ["太阳穴", "印堂穴", "合谷穴", "耳穴压豆"] },
        { id: "adult-sleep", label: "睡眠不佳", aliases: ["过敏性鼻炎伴睡眠不佳", "睡眠不佳"], titles: ["颈三线刮痧"] },
        { id: "adult-skin", label: "局部皮疹", aliases: ["局部湿疹", "皮疹", "瘙痒"], titles: ["麦灸棒点灸"] }
      ] }
    ]
  },
  {
    id: "child",
    label: "儿童方案",
    sections: [
      { id: "child-quick", label: "快速通窍方案", categories: [{ id: "child-quick-content", label: "快速通窍方案", aliases: ["儿童快速通窍方案", "儿童快速通窍"], titles: ["鼻炎手法", "头面四大手法", "鼻三线姜刮"] }] },
      { id: "child-conditioning", label: "调体方案", categories: [{ id: "child-conditioning-content", label: "调体方案", aliases: ["儿童调体方案", "儿童调体"], titles: ["过敏手法", "呼吸手法", "清肺经", "清大肠", "揉天枢", "摩腹", "消化手法", "清热手法"] }] }
    ]
  }
];

function normalized(value) {
  return String(value || "").replace(/[\s·——、，,()（）+]/g, "").toLocaleLowerCase();
}

function belongsToCategory(item, category) {
  var categoryText = normalized(item.category);
  var titleText = normalized(item.title);
  return (category.aliases || []).some(function (alias) { return categoryText.indexOf(normalized(alias)) >= 0; }) ||
    (category.titles || []).some(function (title) { return titleText.indexOf(normalized(title)) >= 0; });
}

module.exports = {
  catalogs: LEARNING_CATALOGS,
  belongsToCategory: belongsToCategory
};
