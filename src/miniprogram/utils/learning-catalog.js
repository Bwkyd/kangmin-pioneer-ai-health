// 分类树完全由服务端 truth 注册表生成；客户端不保留标题/别名猜测规则。
function catalogsFromRegistry(nodes) {
  nodes = Array.isArray(nodes) ? nodes : [];
  return nodes.filter(function (node) { return node.nodeType === "audience"; }).map(function (root) {
    return {
      id: root.audience,
      label: root.name,
      sections: nodes.filter(function (node) {
        return node.parentId === root.id && node.nodeType === "group";
      }).map(function (group) {
        return {
          id: group.id,
          label: group.name,
          categories: nodes.filter(function (node) {
            return node.parentId === group.id && node.selectable;
          }).map(function (leaf) { return { id: leaf.id, label: leaf.name }; })
        };
      }).filter(function (section) { return section.categories.length > 0; })
    };
  }).filter(function (catalog) { return catalog.sections.length > 0; });
}

function belongsToCategory(item, category) {
  return Array.isArray(item.categoryIds) && item.categoryIds.indexOf(category.id) >= 0;
}

module.exports = {
  catalogsFromRegistry: catalogsFromRegistry,
  belongsToCategory: belongsToCategory
};
