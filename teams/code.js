figma.showUI(__html__, { width: 520, height: 780 });

var lockedFrameId = null;

function post(type, data) {
  var msg = { type: type };
  if (data) {
    for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) msg[k] = data[k];
  }
  figma.ui.postMessage(msg);
}

function getBounds(node) {
  if (!node || !node.absoluteBoundingBox) return null;
  return node.absoluteBoundingBox;
}

function isValidFrameNode(node) {
  if (!node) return false;
  var validTypes = ["FRAME", "COMPONENT", "COMPONENT_SET", "SECTION", "GROUP", "INSTANCE"];
  if (validTypes.indexOf(node.type) === -1) return false;
  return !!getBounds(node);
}

function framePayload(node) {
  var b = getBounds(node);
  return {
    id: node.id,
    name: node.name,
    width: Math.round(b.width),
    height: Math.round(b.height)
  };
}

function getSelectedFrame() {
  var selection = figma.currentPage.selection;
  if (!selection || selection.length === 0) return { frame: null, error: "Select a frame." };
  if (selection.length > 1) return { frame: null, error: "Select only one frame." };

  var node = selection[0];
  if (!isValidFrameNode(node)) return { frame: null, error: node.name + " is a " + node.type + ", not a frame." };
  return { frame: node, error: null };
}

function resolveActiveFrame() {
  if (lockedFrameId) {
    var lockedNode = figma.getNodeById(lockedFrameId);
    if (isValidFrameNode(lockedNode)) return lockedNode;
    lockedFrameId = null;
  }

  var sel = getSelectedFrame();
  return sel.frame || null;
}

function sendSelection() {
  var node = resolveActiveFrame();
  if (node) {
    post("update", { frame: framePayload(node), error: null, locked: !!lockedFrameId });
    return;
  }

  var sel = getSelectedFrame();
  post("update", {
    frame: null,
    error: sel.error,
    locked: false
  });
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function toInt(n, fallback) {
  var parsed = Number(n);
  if (Number.isFinite(parsed)) return Math.round(parsed);
  return fallback;
}

function mergeIntervals(intervals, joinGap) {
  if (!intervals.length) return [];
  intervals.sort(function(a, b) { return a.start - b.start; });

  var merged = [intervals[0]];
  for (var i = 1; i < intervals.length; i++) {
    var prev = merged[merged.length - 1];
    var cur = intervals[i];
    if (cur.start <= prev.end + joinGap) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

function splitByMaxHeight(interval, maxH) {
  var out = [];
  var y = interval.start;
  while (y < interval.end) {
    var h = Math.min(maxH, interval.end - y);
    out.push({ start: y, end: y + h });
    y += h;
  }
  return out;
}

function suggestSlices(frameNode, opts) {
  var frameBounds = getBounds(frameNode);
  if (!frameBounds) return [];

  var frameWidth = Math.round(frameNode.width);
  var frameHeight = Math.round(frameNode.height);

  var headerHeight = clamp(toInt(opts && opts.headerHeight, 0), 0, frameHeight);
  var footerHeight = clamp(toInt(opts && opts.footerHeight, 0), 0, frameHeight);
  var maxSliceHeight = Math.max(200, toInt(opts && opts.maxSliceHeight, 1200));

  var bodyTop = headerHeight;
  var bodyBottom = frameHeight - footerHeight;
  if (bodyBottom <= bodyTop) return [];

  var minSectionHeight = Math.max(40, Math.round(frameHeight * 0.03));
  var minWidth = Math.max(120, Math.round(frameWidth * 0.55));
  var joinGap = Math.max(12, Math.round(frameHeight * 0.01));

  var intervals = [];
  if ("children" in frameNode && Array.isArray(frameNode.children)) {
    for (var i = 0; i < frameNode.children.length; i++) {
      var child = frameNode.children[i];
      if (!child || child.visible === false) continue;

      var b = getBounds(child);
      if (!b) continue;

      var relY = Math.round(b.y - frameBounds.y);
      var relH = Math.round(b.height);
      var relW = Math.round(b.width);

      if (relW < minWidth) continue;
      if (relH < minSectionHeight) continue;

      var start = clamp(relY, bodyTop, bodyBottom);
      var end = clamp(relY + relH, bodyTop, bodyBottom);
      if (end - start < minSectionHeight) continue;

      intervals.push({ start: start, end: end });
    }
  }

  if (!intervals.length) {
    intervals.push({ start: bodyTop, end: bodyBottom });
  }

  var merged = mergeIntervals(intervals, joinGap);

  var slices = [];
  for (var m = 0; m < merged.length; m++) {
    var chunks = splitByMaxHeight(merged[m], maxSliceHeight);
    for (var c = 0; c < chunks.length; c++) {
      var h = chunks[c].end - chunks[c].start;
      if (h < 8) continue;
      slices.push({
        rect: {
          x: 0,
          y: chunks[c].start,
          width: frameWidth,
          height: h
        },
        url: "",
        alt: "",
        label: ""
      });
    }
  }

  if (!slices.length) {
    var y = bodyTop;
    while (y < bodyBottom) {
      var h2 = Math.min(maxSliceHeight, bodyBottom - y);
      slices.push({ rect: { x: 0, y: y, width: frameWidth, height: h2 }, url: "", alt: "", label: "" });
      y += h2;
    }
  }

  return slices;
}

figma.ui.onmessage = function(msg) {
  if (!msg || !msg.type) return;

  if (msg.type === "refresh") {
    sendSelection();
    return;
  }

  if (msg.type === "lock-frame") {
    var sel = getSelectedFrame();
    if (!sel.frame) {
      post("lock-result", { ok: false, error: sel.error });
      return;
    }
    lockedFrameId = sel.frame.id;
    sendSelection();
    post("lock-result", { ok: true, locked: true });
    return;
  }

  if (msg.type === "unlock-frame") {
    lockedFrameId = null;
    sendSelection();
    post("lock-result", { ok: true, locked: false });
    return;
  }

  if (msg.type === "preview") {
    var previewNode = resolveActiveFrame();
    if (!previewNode) {
      post("preview-error", { message: "No frame selected" });
      return;
    }

    previewNode.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } })
      .then(function(bytes) {
        post("preview-done", {
          base64: figma.base64Encode(bytes),
          logicalWidth: Math.round(previewNode.width),
          logicalHeight: Math.round(previewNode.height),
          name: previewNode.name
        });
      })
      .catch(function(err) {
        post("preview-error", { message: err.message || "Preview export failed" });
      });
    return;
  }

  if (msg.type === "auto-suggest") {
    var activeNode = resolveActiveFrame();
    if (!activeNode) {
      post("suggest-error", { message: "No frame selected" });
      return;
    }

    try {
      var suggestions = suggestSlices(activeNode, {
        headerHeight: msg.headerHeight,
        footerHeight: msg.footerHeight,
        maxSliceHeight: msg.maxSliceHeight
      });
      post("suggest-done", { slices: suggestions, count: suggestions.length });
    } catch (err) {
      post("suggest-error", { message: err.message || "Slice suggestion failed" });
    }
    return;
  }

  if (msg.type === "export") {
    var node = resolveActiveFrame();
    if (!node) {
      post("export-error", { message: "No frame selected" });
      return;
    }

    var exportScale = 2;
    node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: exportScale } })
      .then(function(bytes) {
        post("export-done", {
          base64: figma.base64Encode(bytes),
          logicalWidth: Math.round(node.width),
          logicalHeight: Math.round(node.height),
          pixelRatio: exportScale,
          exportWidth: Math.round(node.width * exportScale),
          exportHeight: Math.round(node.height * exportScale),
          name: node.name,
          manualSlices: Array.isArray(msg.manualSlices) ? msg.manualSlices : []
        });
      })
      .catch(function(err) {
        post("export-error", { message: err.message || "Export failed" });
      });
    return;
  }

  if (msg.type === "notify") {
    figma.notify(msg.message || "Done");
  }
};

figma.on("selectionchange", function() {
  sendSelection();
});

sendSelection();
