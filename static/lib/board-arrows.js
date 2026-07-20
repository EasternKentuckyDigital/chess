let layerCount = 0;

function arrowPoint(square, flipped) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return {
    x: (flipped ? 7 - file : file) * 100 + 50,
    y: (flipped ? rank : 7 - rank) * 100 + 50,
  };
}

export function createBoardArrows({ board, svg, squareSelector, squareData, isFlipped, color = "#d18b2c" }) {
  const id = ++layerCount;
  const userArrows = new Map();
  const systemArrows = new Map();
  let drawing = null;
  let drawingButton = null;
  let previewTo = null;

  function squareAt(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY)?.closest(squareSelector);
    return element && board.contains(element) ? element.dataset[squareData] : null;
  }

  function arrowMarkup(uci, arrowColor, markerId, opacity = .84) {
    const start = arrowPoint(uci.slice(0, 2), isFlipped());
    const end = arrowPoint(uci.slice(2, 4), isFlipped());
    return `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="${arrowColor}" stroke-width="17" stroke-linecap="round" opacity="${opacity}" marker-end="url(#${markerId})"/>`;
  }

  function render() {
    const userMarker = `user-arrow-${id}`;
    const systemMarker = `system-arrow-${id}`;
    const systemColor = systemArrows.values().next().value?.color || "#2d7a55";
    const preview = drawing && previewTo && previewTo !== drawing ? `${drawing}${previewTo}` : null;
    svg.innerHTML = `<defs>
      <marker id="${userMarker}" markerWidth="5" markerHeight="5" refX="3.5" refY="2.5" orient="auto"><path d="M0,0 L0,5 L5,2.5 z" fill="${color}"/></marker>
      <marker id="${systemMarker}" markerWidth="5" markerHeight="5" refX="3.5" refY="2.5" orient="auto"><path d="M0,0 L0,5 L5,2.5 z" fill="${systemColor}"/></marker>
    </defs>${[...systemArrows].map(([uci, item]) => arrowMarkup(uci, item.color, systemMarker)).join("")}${[...userArrows].map(([uci]) => arrowMarkup(uci, color, userMarker)).join("")}${preview ? arrowMarkup(preview, color, userMarker, .55) : ""}`;
  }

  function pointerDown(event) {
    const arrowGesture = event.button === 2 || event.button === 0 && event.shiftKey;
    if (!arrowGesture) return;
    const square = event.target instanceof Element ? event.target.closest(squareSelector)?.dataset[squareData] : null;
    if (!square) return;
    event.preventDefault();
    drawing = square;
    drawingButton = event.button;
    previewTo = square;
  }

  function pointerMove(event) {
    if (!drawing) return;
    event.preventDefault();
    const square = squareAt(event.clientX, event.clientY);
    if (square && square !== previewTo) {
      previewTo = square;
      render();
    }
  }

  function pointerUp(event) {
    if (!drawing || event.button !== drawingButton) return;
    event.preventDefault();
    const destination = squareAt(event.clientX, event.clientY);
    const uci = destination && destination !== drawing ? `${drawing}${destination}` : null;
    drawing = null;
    drawingButton = null;
    previewTo = null;
    if (uci) {
      if (userArrows.has(uci)) userArrows.delete(uci);
      else userArrows.set(uci, true);
    }
    render();
  }

  function contextMenu(event) {
    if (event.target.closest(squareSelector)) event.preventDefault();
  }

  board.addEventListener("pointerdown", pointerDown);
  board.addEventListener("contextmenu", contextMenu);
  document.addEventListener("pointermove", pointerMove, { passive: false });
  document.addEventListener("pointerup", pointerUp, { passive: false });

  return {
    clear() { userArrows.clear(); systemArrows.clear(); render(); },
    clearSystem() { systemArrows.clear(); render(); },
    refresh: render,
    setSystemArrow(uci, arrowColor = "#2d7a55") { systemArrows.clear(); if (uci) systemArrows.set(uci, { color: arrowColor }); render(); },
    destroy() {
      board.removeEventListener("pointerdown", pointerDown);
      board.removeEventListener("contextmenu", contextMenu);
      document.removeEventListener("pointermove", pointerMove);
      document.removeEventListener("pointerup", pointerUp);
    },
  };
}
