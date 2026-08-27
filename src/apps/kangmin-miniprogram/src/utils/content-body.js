var MEDIA_PATTERN = /^\/v1\/media\/(med_[0-9a-f]{12})$/;

function mediaUrl(raw, convert) {
  var match = MEDIA_PATTERN.exec(String(raw || "").trim());
  return match && match[1] ? convert("/v1/media/" + match[1]) : "";
}

function inlineNodes(text, convert) {
  var nodes = [];
  var pattern = /(!?)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  var cursor = 0;
  var match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push({ type: "text", text: text.slice(cursor, match.index) });
    var isImage = match[1] === "!";
    var label = match[2] || "链接";
    var rawHref = match[3] || "";
    if (isImage) {
      var imageSrc = mediaUrl(rawHref, convert);
      if (imageSrc) nodes.push({ name: "img", attrs: { src: imageSrc, alt: label, mode: "widthFix" } });
      else nodes.push({ type: "text", text: label });
    } else {
      var href = /^https?:\/\//u.test(rawHref) ? rawHref : mediaUrl(rawHref, convert);
      if (href) nodes.push({ name: "a", attrs: { href: href }, children: [{ type: "text", text: label }] });
      else nodes.push({ type: "text", text: label });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) nodes.push({ type: "text", text: text.slice(cursor) });
  return nodes;
}

function parseContentBody(body, convert) {
  var lines = String(body || "").replace(/\r\n/g, "\n").split("\n");
  var nodes = [];
  lines.forEach(function (line) {
    var value = line.trimEnd();
    if (!value.trim()) return;
    var heading = /^(#{1,3})\s+(.+)$/u.exec(value);
    if (heading) {
      nodes.push({ name: heading[1].length === 1 ? "h2" : "h3", children: inlineNodes(heading[2], convert) });
      return;
    }
    var quote = /^>\s+(.+)$/u.exec(value);
    if (quote) {
      nodes.push({ name: "p", attrs: { style: "color:#6f7f8f;" }, children: inlineNodes(quote[1], convert) });
      return;
    }
    var unordered = /^[-*]\s+(.+)$/u.exec(value);
    var ordered = /^(\d+)\.\s+(.+)$/u.exec(value);
    if (unordered || ordered) {
      nodes.push({ name: "p", attrs: { style: "margin-left:24rpx;" }, children: [{ type: "text", text: (unordered ? "• " : ordered[1] + ". ") }].concat(inlineNodes((unordered || ordered)[unordered ? 1 : 2], convert)) });
      return;
    }
    nodes.push({ name: "p", children: inlineNodes(value, convert) });
  });
  return nodes;
}

module.exports = { parseContentBody: parseContentBody };
