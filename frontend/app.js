// Owner: Person A. Minimal working loop; build on it.
const INTERVAL_MS = 3000;
const $ = (id) => document.getElementById(id);

$("start").onclick = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: 640 },
  });
  $("cam").srcObject = stream;
  try { await navigator.wakeLock?.request("screen"); } catch {}
  setInterval(sendFrame, INTERVAL_MS);
  $("status").textContent = "haunting…";
};

function sendFrame() {
  const v = $("cam"), c = $("grab");
  if (!v.videoWidth) return;
  c.width = 640;
  c.height = Math.round((640 * v.videoHeight) / v.videoWidth);
  c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
  c.toBlob((blob) => {
    const fd = new FormData();
    fd.append("image", blob, "f.jpg");
    fd.append("ts", Date.now());
    fetch("/frame", { method: "POST", body: fd })
      .then((r) => r.json())
      .then((j) => ($("status").textContent = `saw: ${j.caption?.scene}`))
      .catch((e) => console.error(e));
  }, "image/jpeg", 0.7);
}

$("askForm").onsubmit = async (e) => {
  e.preventDefault();
  const r = await fetch("/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: $("q").value }),
  });
  const j = await r.json();
  $("answer").textContent = j.answer;
  $("frames").innerHTML = j.frames.map((f) => `<img src="${f.url}" title="${f.note}">`).join("");
  speechSynthesis.speak(new SpeechSynthesisUtterance(j.answer)); // TODO(A): spooky voice
};
