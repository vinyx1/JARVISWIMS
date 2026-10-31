// Boxes use Kenny's locate_object format: [x0, y0, x1, y1], fractions of the source image.
export function boxToRect(box, width, height) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) return null;
  if (![width, height].every(n => Number.isFinite(n) && n > 0)) return null;
  const [x0, y0, x1, y1] = box;
  if (x1 <= x0 || y1 <= y0) return null;
  return {x: x0 * width, y: y0 * height, width: (x1 - x0) * width, height: (y1 - y0) * height};
}

export function createObjectOverlay(image, layer) {
  let selectedBox = null;
  const rectangle = layer.querySelector('rect');
  function update() {
    const rect = image.complete && boxToRect(selectedBox, image.naturalWidth, image.naturalHeight);
    layer.toggleAttribute('hidden', !rect);
    if (!rect) return;
    // SVG's centered 'meet' fit matches the image's object-fit: contain, including letterboxing.
    layer.setAttribute('viewBox', `0 0 ${image.naturalWidth} ${image.naturalHeight}`);
    for (const [name, value] of Object.entries(rect)) rectangle.setAttribute(name, String(value));
  }
  function clear() { selectedBox = null; layer.setAttribute('hidden', ''); }
  image.addEventListener('load', update);
  image.addEventListener('error', clear);
  return {set(box) { selectedBox = boxToRect(box, 1, 1) ? [...box] : null; update(); }, clear};
}
