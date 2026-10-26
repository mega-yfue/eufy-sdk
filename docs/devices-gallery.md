<script setup>
import { ref, watch, onMounted } from "vue";

const q = ref("");
const noResults = ref(false);
const view = ref("photo");

// Model code (uppercase) → built URL of its line-art icon. Globbed rather than listed, so dropping an
// SVG into device-icons/ is all it takes, and Vite resolves the URL against the site base.
const ICONS = Object.fromEntries(
  Object.entries(
    import.meta.glob("./device-icons/*.svg", { query: "?url", import: "default", eager: true }),
  ).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -4).toUpperCase(), url]),
);

// Show each tile's photo or its icon. A tile's icon is the first of its model codes that has one; a
// tile with no icon keeps its photo in both views, and a tile with no photo shows its icon in both.
// The icon is drawn as a mask over the text colour, so the black line art follows the light and dark
// theme.
function applyView() {
  if (typeof document === "undefined") return;
  document.querySelectorAll(".device-gallery figure").forEach((fig) => {
    const img = fig.querySelector("img");
    const codes = (fig.querySelector(".model")?.textContent ?? "").split("·").map((c) => c.trim().toUpperCase());
    const icon = codes.map((c) => ICONS[c]).find(Boolean);
    let tile = fig.querySelector(".device-icon");
    if (icon && !tile) {
      tile = document.createElement("span");
      tile.className = "device-icon";
      tile.setAttribute("role", "img");
      tile.setAttribute("aria-label", fig.textContent.trim());
      tile.style.setProperty("--icon", `url("${icon}")`);
      fig.prepend(tile);
    }
    const useIcon = !!tile && (view.value === "icon" || !img);
    if (img) img.hidden = useIcon;
    if (tile) tile.hidden = !useIcon;
  });
}

function apply() {
  if (typeof document === "undefined") return;
  const term = q.value.trim().toLowerCase();
  let anyAtAll = false;
  document.querySelectorAll(".device-gallery").forEach((grid) => {
    let visible = 0;
    grid.querySelectorAll("figure").forEach((fig) => {
      const hay = (fig.textContent + " " + (fig.querySelector("img")?.alt ?? "")).toLowerCase();
      const show = !term || hay.includes(term);
      fig.style.display = show ? "" : "none";
      if (show) visible++;
    });
    grid.style.display = visible ? "" : "none";
    let h = grid.previousElementSibling;
    while (h && !/^H[1-3]$/.test(h.tagName)) h = h.previousElementSibling;
    if (h && h.tagName === "H3") h.style.display = visible ? "" : "none";
    if (visible) anyAtAll = true;
  });
  noResults.value = !!term && !anyAtAll;
}

onMounted(() => {
  apply();
  applyView();
});
watch(q, apply);
watch(view, applyView);
</script>

# Devices

One SDK for the entire Anker eufy ecosystem — **Security**, **Clean** (RoboVac), **Robot Mowers**,
**Display**, **Mum & Baby**, and **Life**.

::: info Independent and unofficial
Device names, model codes, and product imagery on this page identify the hardware this SDK talks to.
eufy-sdk is not affiliated with, endorsed by, or sponsored by Anker Innovations, Anker eufy, or eufy,
and this
page is a visual reference — not a support or compatibility list published by either company.
:::

eufy-sdk is capability-driven, not device-driven. It reads what a device reports — its category,
type, and parameters — resolves the capabilities that follow, and exposes them through one fluent API.
Capabilities are resolved, not hardcoded per model, so the same code drives devices it has never seen
and new hardware as eufy ships it, on any product line. A few individual writes are held back to the
hardware they were confirmed on, and each one says so where it's documented.

Devices are identified by their **model code** (`Txxxxx`), which is unique across the whole ecosystem.
The gallery is organised by family; **Security**, **Clean** and **Life** are illustrated below, and every other
line resolves through the identical mechanism.

::: tip A reference, not a limit
Presence here means "pictured", not "the only thing supported" — an unrecognised device still resolves
from its reported capabilities. See [Devices & capabilities](/devices) for how resolution works and
[Under the hood](/architecture) for the model behind it.
:::

<div class="device-search">
  <input
    type="search"
    v-model="q"
    placeholder="Filter devices — name or model (e.g. C24, T8410, doorbell)"
    aria-label="Filter devices by name or model code"
  />
  <div class="device-view" role="group" aria-label="Show devices as">
    <button type="button" :aria-pressed="view === 'photo'" @click="view = 'photo'">Photo</button>
    <button type="button" :aria-pressed="view === 'icon'" @click="view = 'icon'">Icon</button>
  </div>
</div>

<p v-show="noResults" class="device-search-empty">No device matches — try a model code (<code>T8410</code>) or a name (<code>doorbell</code>).</p>

## 🛡️ Security

### 🏠 Bases, NVR & chime

<div class="device-gallery">

<figure>
  <img src="/devices/security/security-T8001.webp" alt="HomeBase T8001 · T8002" loading="lazy" />
  <figcaption>HomeBase <span class="model">T8001 · T8002</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8010.webp" alt="HomeBase 2 (S280) T8010" loading="lazy" />
  <figcaption>HomeBase 2 (S280) <span class="model">T8010</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8023.webp" alt="MiniBase Chime T8023" loading="lazy" />
  <figcaption>MiniBase Chime <span class="model">T8023</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8025.webp" alt="HomeBase mini T8025" loading="lazy" />
  <figcaption>HomeBase mini <span class="model">T8025</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8030.webp" alt="HomeBase 3 (S380) T8030" loading="lazy" />
  <figcaption>HomeBase 3 (S380) <span class="model">T8030</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8N00.webp" alt="NVR S4 Max T8N00" loading="lazy" />
  <figcaption>NVR S4 Max <span class="model">T8N00</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T9000.webp" alt="HomeBase S1 Pro T9000" loading="lazy" />
  <figcaption>HomeBase S1 Pro <span class="model">T9000</span></figcaption>
</figure>

</div>

### 🔔 Doorbells

<div class="device-gallery">

<figure>
  <img src="/devices/security/security-T8200.webp" alt="Wired Doorbell 2K T8200 · T8200X" loading="lazy" />
  <figcaption>Wired Doorbell 2K <span class="model">T8200 · T8200X</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8201.webp" alt="Wired Doorbell T8201" loading="lazy" />
  <figcaption>Wired Doorbell <span class="model">T8201</span></figcaption>
</figure>
<figure>
  <figcaption>Wired Doorbell 2K Pro <span class="model">T8202</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8203.webp" alt="Wired Doorbell Dual T8203" loading="lazy" />
  <figcaption>Wired Doorbell Dual <span class="model">T8203</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8210.webp" alt="Battery Doorbell 2K T8210 · T8212" loading="lazy" />
  <figcaption>Battery Doorbell 2K <span class="model">T8210 · T8212</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8213.webp" alt="Battery Doorbell 2K Dual T8213" loading="lazy" />
  <figcaption>Battery Doorbell 2K Dual <span class="model">T8213</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8214.webp" alt="Battery Doorbell E340 T8214" loading="lazy" />
  <figcaption>Battery Doorbell E340 <span class="model">T8214</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8215.webp" alt="Video Doorbell S4 T8215" loading="lazy" />
  <figcaption>Video Doorbell S4 <span class="model">T8215</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8220.webp" alt="Battery Doorbell Slim T8220" loading="lazy" />
  <figcaption>Battery Doorbell Slim <span class="model">T8220</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8221.webp" alt="Battery Doorbell 2E T8221" loading="lazy" />
  <figcaption>Battery Doorbell 2E <span class="model">T8221</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8222.webp" alt="Battery Doorbell T8222" loading="lazy" />
  <figcaption>Battery Doorbell <span class="model">T8222</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8223.webp" alt="Doorbell C31 T8223" loading="lazy" />
  <figcaption>Doorbell C31 <span class="model">T8223</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8224.webp" alt="Battery Doorbell C30 T8224" loading="lazy" />
  <figcaption>Battery Doorbell C30 <span class="model">T8224</span></figcaption>
</figure>

</div>

### 🔦 Floodlight cams

<div class="device-gallery">

<figure>
  <img src="/devices/security/security-T8420.webp" alt="Floodlight Cam T8420 · T8420X · T8422" loading="lazy" />
  <figcaption>Floodlight Cam <span class="model">T8420 · T8420X · T8422</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8423.webp" alt="Floodlight Cam S330 (2 Pro) T8423" loading="lazy" />
  <figcaption>Floodlight Cam S330 (2 Pro) <span class="model">T8423</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8424.webp" alt="Floodlight Cam 2 T8424" loading="lazy" />
  <figcaption>Floodlight Cam 2 <span class="model">T8424</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8425.webp" alt="Floodlight Cam E340 T8425" loading="lazy" />
  <figcaption>Floodlight Cam E340 <span class="model">T8425</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8426.webp" alt="Floodlight Cam E30 T8426" loading="lazy" />
  <figcaption>Floodlight Cam E30 <span class="model">T8426</span></figcaption>
</figure>

</div>

### 📷 Cameras

<div class="device-gallery">

<figure>
  <img src="/devices/security/security-T8110.webp" alt="SoloCam C35 T8110" loading="lazy" />
  <figcaption>SoloCam C35 <span class="model">T8110</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8111.webp" alt="eufyCam T8111 · T8112" loading="lazy" />
  <figcaption>eufyCam <span class="model">T8111 · T8112</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8113.webp" alt="eufyCam 2C T8113" loading="lazy" />
  <figcaption>eufyCam 2C <span class="model">T8113</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8114.webp" alt="eufyCam 2 T8114" loading="lazy" />
  <figcaption>eufyCam 2 <span class="model">T8114</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8122.webp" alt="SoloCam L20 T8122 · T8123" loading="lazy" />
  <figcaption>SoloCam L20 <span class="model">T8122 · T8123</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8124.webp" alt="SoloCam S230 (S40) T8124" loading="lazy" />
  <figcaption>SoloCam S230 (S40) <span class="model">T8124</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8130.webp" alt="SoloCam E20 T8130" loading="lazy" />
  <figcaption>SoloCam E20 <span class="model">T8130</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8131.webp" alt="SoloCam C120 (E40) T8131" loading="lazy" />
  <figcaption>SoloCam C120 (E40) <span class="model">T8131</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8134.webp" alt="SoloCam S220 T8134" loading="lazy" />
  <figcaption>SoloCam S220 <span class="model">T8134</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8140.webp" alt="eufyCam 2 Pro T8140" loading="lazy" />
  <figcaption>eufyCam 2 Pro <span class="model">T8140</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8141.webp" alt="eufyCam 2C Pro T8141 · T8142 · T8142-Z" loading="lazy" />
  <figcaption>eufyCam 2C Pro <span class="model">T8141 · T8142 · T8142-Z</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8144.webp" alt="eufyCam E40 T8144" loading="lazy" />
  <figcaption>eufyCam E40 <span class="model">T8144</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8150.webp" alt="4G Starlight Cam T8150 · T8151 · T8152 · T8153" loading="lazy" />
  <figcaption>4G Starlight Cam <span class="model">T8150 · T8151 · T8152 · T8153</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8160.webp" alt="eufyCam S330 (3) T8160" loading="lazy" />
  <figcaption>eufyCam S330 (3) <span class="model">T8160</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8161.webp" alt="eufyCam S300 (3C) T8161" loading="lazy" />
  <figcaption>eufyCam S300 (3C) <span class="model">T8161</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8162.webp" alt="eufyCam S3 Pro T8162 · T8892 · T8894" loading="lazy" />
  <figcaption>eufyCam S3 Pro <span class="model">T8162 · T8892 · T8894</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8170.webp" alt="SoloCam S340 T8170" loading="lazy" />
  <figcaption>SoloCam S340 <span class="model">T8170</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8171.webp" alt="SoloCam E30 T8171" loading="lazy" />
  <figcaption>SoloCam E30 <span class="model">T8171</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8172.webp" alt="eufyCam S4 T8172" loading="lazy" />
  <figcaption>eufyCam S4 <span class="model">T8172</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8173.webp" alt="SoloCam E42 T8173" loading="lazy" />
  <figcaption>SoloCam E42 <span class="model">T8173</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8400.webp" alt="Solo Indoor Cam C24 T8400" loading="lazy" />
  <figcaption>Solo Indoor Cam C24 <span class="model">T8400</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8410.webp" alt="Indoor Cam P24 T8410 · T8411" loading="lazy" />
  <figcaption>Indoor Cam P24 <span class="model">T8410 · T8411</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8414.webp" alt="Indoor Cam Mini T8414" loading="lazy" />
  <figcaption>Indoor Cam Mini <span class="model">T8414</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8416.webp" alt="Indoor Cam S350 T8416" loading="lazy" />
  <figcaption>Indoor Cam S350 <span class="model">T8416</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8417.webp" alt="Indoor Cam E30 T8417" loading="lazy" />
  <figcaption>Indoor Cam E30 <span class="model">T8417</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8419.webp" alt="Indoor Cam C210 T8419" loading="lazy" />
  <figcaption>Indoor Cam C210 <span class="model">T8419</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8419N.webp" alt="Indoor Cam C220 T8419N" loading="lazy" />
  <figcaption>Indoor Cam C220 <span class="model">T8419N</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8452.webp" alt="Garage-Control Cam T8452" loading="lazy" />
  <figcaption>Garage-Control Cam <span class="model">T8452</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T84A0.webp" alt="Wall Light Cam S120 T84A0" loading="lazy" />
  <figcaption>Wall Light Cam S120 <span class="model">T84A0</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T81A0.webp" alt="Solar Wall Light Cam S120 T81A0" loading="lazy" />
  <figcaption>Solar Wall Light Cam S120 <span class="model">T81A0</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T84A1.webp" alt="Wall Light Cam S100 T84A1" loading="lazy" />
  <figcaption>Wall Light Cam S100 <span class="model">T84A1</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8600.webp" alt="eufyCam E330 (Pro) T8600" loading="lazy" />
  <figcaption>eufyCam E330 (Pro) <span class="model">T8600</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T86P2.webp" alt="4G LTE Cam S330 T86P2" loading="lazy" />
  <figcaption>4G LTE Cam S330 <span class="model">T86P2</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8B0.webp" alt="SoloCam C210 T8B0" loading="lazy" />
  <figcaption>SoloCam C210 <span class="model">T8B0</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8E00.webp" alt="PoE Bullet PTZ Cam S4 T8E00" loading="lazy" />
  <figcaption>PoE Bullet PTZ Cam S4 <span class="model">T8E00</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8P00.webp" alt="PoE Cam E40 T8P00" loading="lazy" />
  <figcaption>PoE Cam E40 <span class="model">T8P00</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8W11C.webp" alt="Indoor Cam C220 T8W11 · T8W11C · T8419N" loading="lazy" />
  <figcaption>Indoor Cam C220 <span class="model">T8W11 · T8W11C · T8419N</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8401.webp" alt="Solo Indoor Cam C22 T8401" loading="lazy" />
  <figcaption>Solo Indoor Cam C22 <span class="model">T8401</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8442.webp" alt="Solo Outdoor Cam C22 T8442" loading="lazy" />
  <figcaption>Solo Outdoor Cam C22 <span class="model">T8442</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8441.webp" alt="Solo Outdoor Cam C24 T8441" loading="lazy" />
  <figcaption>Solo Outdoor Cam C24 <span class="model">T8441</span></figcaption>
</figure>

</div>

### 🔒 Smart locks & access

<div class="device-gallery">

<figure>
  <img src="/devices/security/security-T8021.webp" alt="Smart Lock Wi-Fi Bridge T8021" loading="lazy" />
  <figcaption>Smart Lock Wi-Fi Bridge <span class="model">T8021</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8500.webp" alt="Smart Lock T8500" loading="lazy" />
  <figcaption>Smart Lock <span class="model">T8500</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8502.webp" alt="Smart Lock Touch & Wi-Fi T8502" loading="lazy" />
  <figcaption>Smart Lock Touch & Wi-Fi <span class="model">T8502</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8503.webp" alt="Smart Lock T8503" loading="lazy" />
  <figcaption>Smart Lock <span class="model">T8503</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8504.webp" alt="Smart Lock T8504" loading="lazy" />
  <figcaption>Smart Lock <span class="model">T8504</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8506.webp" alt="Smart Lock Touch & Wi-Fi T8506" loading="lazy" />
  <figcaption>Smart Lock Touch & Wi-Fi <span class="model">T8506</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8510.webp" alt="Smart Lock Touch T8510" loading="lazy" />
  <figcaption>Smart Lock Touch <span class="model">T8510</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8510P.webp" alt="Smart Lock T8510P · T8520P" loading="lazy" />
  <figcaption>Smart Lock <span class="model">T8510P · T8520P</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8520.webp" alt="Smart Lock Touch & Wi-Fi T8520" loading="lazy" />
  <figcaption>Smart Lock Touch & Wi-Fi <span class="model">T8520</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8530.webp" alt="Video Smart Lock T8530" loading="lazy" />
  <figcaption>Video Smart Lock <span class="model">T8530</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8531.webp" alt="Video Smart Lock T8531" loading="lazy" />
  <figcaption>Video Smart Lock <span class="model">T8531</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T85D0.webp" alt="Smart Lock T85D0" loading="lazy" />
  <figcaption>Smart Lock <span class="model">T85D0</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T85L0.webp" alt="Smart Lock T85L0" loading="lazy" />
  <figcaption>Smart Lock <span class="model">T85L0</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T85P0.webp" alt="Smart Lock T85P0" loading="lazy" />
  <figcaption>Smart Lock <span class="model">T85P0</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T85V0.webp" alt="Smart Lock T85V0" loading="lazy" />
  <figcaption>Smart Lock <span class="model">T85V0</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8790.webp" alt="SmartDrop T8790" loading="lazy" />
  <figcaption>SmartDrop <span class="model">T8790</span></figcaption>
</figure>

</div>

### 🔐 Safes

<div class="device-gallery">

<figure>
  <img src="/devices/security/security-T7400.webp" alt="SmartSafe S10 T7400" loading="lazy" />
  <figcaption>SmartSafe S10 <span class="model">T7400</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T7401.webp" alt="SmartSafe S12 T7401" loading="lazy" />
  <figcaption>SmartSafe S12 <span class="model">T7401</span></figcaption>
</figure>

</div>

### 📍 Trackers

<div class="device-gallery">

<figure>
  <img src="/devices/security/security-T87B0.webp" alt="SmartTrack Link T87B0" loading="lazy" />
  <figcaption>SmartTrack Link <span class="model">T87B0</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T87B2.webp" alt="SmartTrack Card T87B2" loading="lazy" />
  <figcaption>SmartTrack Card <span class="model">T87B2</span></figcaption>
</figure>

</div>

### 📡 Sensors

<div class="device-gallery">

<figure>
  <img src="/devices/security/security-T8900.webp" alt="Sensor T8900" loading="lazy" />
  <figcaption>Sensor <span class="model">T8900</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8910.webp" alt="Motion Sensor T8910" loading="lazy" />
  <figcaption>Motion Sensor <span class="model">T8910</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8920.webp" alt="water freeze sensor t8920 T8920" loading="lazy" />
  <figcaption>water freeze sensor t8920 <span class="model">T8920</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T90E0.webp" alt="Entry Sensor E20 T90E0" loading="lazy" />
  <figcaption>Entry Sensor E20 <span class="model">T90E0</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T90F0.webp" alt="flood freeze sensor e20 t90F0 T90F0" loading="lazy" />
  <figcaption>flood freeze sensor e20 t90F0 <span class="model">T90F0</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T90M0.webp" alt="Motion Sensor T90M0" loading="lazy" />
  <figcaption>Motion Sensor <span class="model">T90M0</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T90R0.webp" alt="Siren T90R0" loading="lazy" />
  <figcaption>Siren <span class="model">T90R0</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T8960.webp" alt="Keypad T8960" loading="lazy" />
  <figcaption>Keypad <span class="model">T8960</span></figcaption>
</figure>
<figure>
  <img src="/devices/security/security-T90S0.webp" alt="smoke alarm e10 t90S0 T90S0" loading="lazy" />
  <figcaption>smoke alarm e10 t90S0 <span class="model">T90S0</span></figcaption>
</figure>

</div>

## 🧹 Clean

The eufy **Clean** line — robot **vacuums** (the classic **RoboVac** and newer **eufy Clean** generations, all one `vacuum` codec) and robot **mowers** (`mower`). Vacuums expose the `vacuumClean`/`suction` capabilities; see the [Vacuums & mowers guide](/vacuums) for the read surface and current limits. Any robot on this line resolves through the same handler, so the models below share behaviour. Most models now have real product photos; a handful of discontinued/region-exclusive SKUs (T2103, T2193, T2210, T2254, T2268, T2270, T280B) still use placeholder art pending a photo.

### 🤖 RoboVac

<div class="device-gallery">

<figure>
  <img src="/devices/clean/clean-T1250.webp" alt="RoboVac 35C T1250" loading="lazy" />
  <figcaption>RoboVac 35C <span class="model">T1250</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2070.webp" alt="RoboVac 3-in-1 E20 T2070" loading="lazy" />
  <figcaption>RoboVac 3-in-1 E20 <span class="model">T2070</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2080.webp" alt="RoboVac S1 T2080" loading="lazy" />
  <figcaption>RoboVac S1 <span class="model">T2080</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2081.webp" alt="RoboVac S2 T2081" loading="lazy" />
  <figcaption>RoboVac S2 <span class="model">T2081</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2103.webp" alt="RoboVac 11C T2103" loading="lazy" />
  <figcaption>RoboVac 11C <span class="model">T2103</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2117.webp" alt="RoboVac 35C T2117" loading="lazy" />
  <figcaption>RoboVac 35C <span class="model">T2117</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2118.webp" alt="RoboVac 30C T2118" loading="lazy" />
  <figcaption>RoboVac 30C <span class="model">T2118</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2119.webp" alt="RoboVac 11S T2119" loading="lazy" />
  <figcaption>RoboVac 11S <span class="model">T2119</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2120.webp" alt="RoboVac 15C MAX T2120" loading="lazy" />
  <figcaption>RoboVac 15C MAX <span class="model">T2120</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2123.webp" alt="RoboVac 25C T2123" loading="lazy" />
  <figcaption>RoboVac 25C <span class="model">T2123</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2128.webp" alt="RoboVac 15C MAX T2128" loading="lazy" />
  <figcaption>RoboVac 15C MAX <span class="model">T2128</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2130.webp" alt="RoboVac 30C MAX T2130" loading="lazy" />
  <figcaption>RoboVac 30C MAX <span class="model">T2130</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2132.webp" alt="RoboVac 25C T2132" loading="lazy" />
  <figcaption>RoboVac 25C <span class="model">T2132</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2150.webp" alt="RoboVac G10 Hybrid T2150" loading="lazy" />
  <figcaption>RoboVac G10 Hybrid <span class="model">T2150</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2181.webp" alt="RoboVac LR30 Hybrid+ T2181" loading="lazy" />
  <figcaption>RoboVac LR30 Hybrid+ <span class="model">T2181</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2182.webp" alt="RoboVac LR35 Hybrid+ T2182" loading="lazy" />
  <figcaption>RoboVac LR35 Hybrid+ <span class="model">T2182</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2190.webp" alt="RoboVac L70 Hybrid T2190" loading="lazy" />
  <figcaption>RoboVac L70 Hybrid <span class="model">T2190</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2192.webp" alt="RoboVac LR20 T2192" loading="lazy" />
  <figcaption>RoboVac LR20 <span class="model">T2192</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2193.webp" alt="RoboVac LR30 Hybrid T2193" loading="lazy" />
  <figcaption>RoboVac LR30 Hybrid <span class="model">T2193</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2194.webp" alt="RoboVac LR35 Hybrid T2194" loading="lazy" />
  <figcaption>RoboVac LR35 Hybrid <span class="model">T2194</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2210.webp" alt="RoboVac G50 T2210" loading="lazy" />
  <figcaption>RoboVac G50 <span class="model">T2210</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T211A.webp" alt="RoboVac C28 T211A" loading="lazy" />
  <figcaption>RoboVac C28 <span class="model">T211A</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2250.webp" alt="RoboVac G30 T2250" loading="lazy" />
  <figcaption>RoboVac G30 <span class="model">T2250</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2251.webp" alt="RoboVac G30 T2251" loading="lazy" />
  <figcaption>RoboVac G30 <span class="model">T2251</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2252.webp" alt="RoboVac G30 Verge T2252" loading="lazy" />
  <figcaption>RoboVac G30 Verge <span class="model">T2252</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2253.webp" alt="RoboVac G30 Hybrid T2253" loading="lazy" />
  <figcaption>RoboVac G30 Hybrid <span class="model">T2253</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2254.webp" alt="RoboVac G35 T2254" loading="lazy" />
  <figcaption>RoboVac G35 <span class="model">T2254</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2255.webp" alt="RoboVac G40 T2255" loading="lazy" />
  <figcaption>RoboVac G40 <span class="model">T2255</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2256.webp" alt="RoboVac G40 Hybrid T2256" loading="lazy" />
  <figcaption>RoboVac G40 Hybrid <span class="model">T2256</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2257.webp" alt="RoboVac G20 T2257" loading="lazy" />
  <figcaption>RoboVac G20 <span class="model">T2257</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2258.webp" alt="RoboVac G20 Hybrid T2258" loading="lazy" />
  <figcaption>RoboVac G20 Hybrid <span class="model">T2258</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2259.webp" alt="RoboVac G32 T2259" loading="lazy" />
  <figcaption>RoboVac G32 <span class="model">T2259</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2261.webp" alt="RoboVac X8 Hybrid T2261" loading="lazy" />
  <figcaption>RoboVac X8 Hybrid <span class="model">T2261</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2262.webp" alt="RoboVac X8 T2262" loading="lazy" />
  <figcaption>RoboVac X8 <span class="model">T2262</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2266.webp" alt="RoboVac X8 Pro T2266" loading="lazy" />
  <figcaption>RoboVac X8 Pro <span class="model">T2266</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2267.webp" alt="RoboVac L60 T2267" loading="lazy" />
  <figcaption>RoboVac L60 <span class="model">T2267</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2268.webp" alt="RoboVac L60 Hybrid T2268" loading="lazy" />
  <figcaption>RoboVac L60 Hybrid <span class="model">T2268</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2270.webp" alt="RoboVac G35+ T2270" loading="lazy" />
  <figcaption>RoboVac G35+ <span class="model">T2270</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2272.webp" alt="RoboVac G30+ SES T2272" loading="lazy" />
  <figcaption>RoboVac G30+ SES <span class="model">T2272</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2273.webp" alt="RoboVac G40 Hybrid+ T2273" loading="lazy" />
  <figcaption>RoboVac G40 Hybrid+ <span class="model">T2273</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2276.webp" alt="RoboVac X8 Pro SES T2276" loading="lazy" />
  <figcaption>RoboVac X8 Pro SES <span class="model">T2276</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2277.webp" alt="RoboVac L60 SES T2277" loading="lazy" />
  <figcaption>RoboVac L60 SES <span class="model">T2277</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2278.webp" alt="RoboVac L60 Hybrid SES T2278" loading="lazy" />
  <figcaption>RoboVac L60 Hybrid SES <span class="model">T2278</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2280.webp" alt="RoboVac C20 T2280" loading="lazy" />
  <figcaption>RoboVac C20 <span class="model">T2280</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2292.webp" alt="RoboVac C10 T2292" loading="lazy" />
  <figcaption>RoboVac C10 <span class="model">T2292</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2320.webp" alt="RoboVac X9 Pro T2320" loading="lazy" />
  <figcaption>RoboVac X9 Pro <span class="model">T2320</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2351.webp" alt="RoboVac X10 Pro Omni T2351" loading="lazy" />
  <figcaption>RoboVac X10 Pro Omni <span class="model">T2351</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2352.webp" alt="RoboVac E28 T2352" loading="lazy" />
  <figcaption>RoboVac E28 <span class="model">T2352</span></figcaption>
</figure>
<figure>
  <img src="/devices/clean/clean-T2353.webp" alt="RoboVac E25 T2353" loading="lazy" />
  <figcaption>RoboVac E25 <span class="model">T2353</span></figcaption>
</figure>

</div>

### 🌱 Mower

<div class="device-gallery">

<figure>
  <img src="/devices/mower/mower-T280B.webp" alt="Mower C15 T280B" loading="lazy" />
  <figcaption>Mower C15 <span class="model">T280B</span></figcaption>
</figure>
<figure>
  <img src="/devices/mower/mower-T2801.webp" alt="Mower E18 T2801" loading="lazy" />
  <figcaption>Mower E18 <span class="model">T2801</span></figcaption>
</figure>
<figure>
  <img src="/devices/mower/mower-T2880.webp" alt="Mower E15 T2880" loading="lazy" />
  <figcaption>Mower E15 <span class="model">T2880</span></figcaption>
</figure>

</div>

## 👶 Baby

### 👶 Baby monitors

<div class="device-gallery">

<figure>
  <img src="/devices/security/security-T8354.webp" alt="Baby Monitor E21 T8354" loading="lazy" />
  <figcaption>Baby Monitor E21 <span class="model">T8354</span></figcaption>
</figure>

</div>

## 🖥️ Display

### 🖥️ Smart displays

The eufy **Display** line — a `display` codec and product line of its own, not a security device: it
connects over secure MQTT with no `p2p_did` and speaks no P2P at all. The `display` capability reads the
screen's charge (param 8001); its retail name, model code and a version-shaped string are readable by
name without a typed getter. Read-only — no display write is captured. See the
[Smart Display guide](/smart-display).

<div class="device-gallery">

<figure>
  <img src="/devices/security/security-T87A0.webp" alt="Smart Display E10 T87A0" loading="lazy" />
  <figcaption>Smart Display E10 <span class="model">T87A0</span></figcaption>
</figure>

</div>

## 💡 Life

### 🔆 Smart lighting

The eufy **Life** smart-lighting line (`smartLight` capability — on/off, brightness, model-limited
custom colour, and gallery effects), driven over secure MQTT. See the [Smart lights guide](/smart-lights). Every model code below
resolves to the same capability for on/off and brightness; effect selection is currently limited to
one model.

<div class="device-gallery">

<figure>
  <img src="/devices/life/life-T8L02.webp" alt="Permanent Outdoor Lights E22 T8L02" loading="lazy" />
  <figcaption>Permanent Outdoor Lights E22 <span class="model">T8L02</span></figcaption>
</figure>
<figure>
  <img src="/devices/life/life-T8L00.webp" alt="Permanent Outdoor Light E120 (30 m) T8L00" loading="lazy" />
  <figcaption>Permanent Outdoor Light E120 (30 m) <span class="model">T8L00</span></figcaption>
</figure>
<figure>
  <img src="/devices/life/life-T8L01.webp" alt="Permanent Outdoor Light E120 (15 m) T8L01" loading="lazy" />
  <figcaption>Permanent Outdoor Light E120 (15 m) <span class="model">T8L01</span></figcaption>
</figure>
<figure>
  <img src="/devices/life/life-T8L04.webp" alt="Permanent Outdoor Lights S4 T8L04" loading="lazy" />
  <figcaption>Permanent Outdoor Lights S4 <span class="model">T8L04</span></figcaption>
</figure>
<figure>
  <img src="/devices/life/life-T8L10.webp" alt="Outdoor String Lights E10 T8L10" loading="lazy" />
  <figcaption>Outdoor String Lights E10 <span class="model">T8L10</span></figcaption>
</figure>
<figure>
  <img src="/devices/life/life-T8L20.webp" alt="Outdoor Spotlights E10 T8L20" loading="lazy" />
  <figcaption>Outdoor Spotlights E10 <span class="model">T8L20</span></figcaption>
</figure>
<figure>
  <img src="/devices/life/life-T8L30.webp" alt="Outdoor Pathway Lights E10 T8L30" loading="lazy" />
  <figcaption>Outdoor Pathway Lights E10 <span class="model">T8L30</span></figcaption>
</figure>
<figure>
  <img src="/devices/life/life-T8L40.webp" alt="Indoor Floor Lamp E10 T8L40" loading="lazy" />
  <figcaption>Indoor Floor Lamp E10 <span class="model">T8L40</span></figcaption>
</figure>

</div>

<style>
.device-search {
  display: flex;
  gap: 10px;
  margin: 18px 0 4px;
}
.device-search input {
  flex: 1;
  min-width: 0;
  padding: 10px 14px;
  font-size: 15px;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  outline: none;
  transition: border-color 0.2s;
}
.device-search input:focus {
  border-color: var(--vp-c-brand-1);
}
.device-view {
  display: flex;
  flex-shrink: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  overflow: hidden;
}
.device-view button {
  padding: 0 14px;
  font-size: 14px;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
  transition: color 0.2s, background 0.2s;
}
.device-view button[aria-pressed="true"] {
  color: var(--vp-c-white);
  background: var(--vp-c-brand-1);
}
.device-search-empty {
  color: var(--vp-c-text-2);
  font-size: 14px;
}
.device-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 18px;
  margin: 16px 0 8px;
}
.device-gallery figure { margin: 0; text-align: center; }
.device-gallery img {
  width: 100%; height: 130px; object-fit: contain;
  background: var(--vp-c-bg-soft); border: 1px solid var(--vp-c-divider);
  border-radius: 10px; padding: 10px;
}
.device-icon {
  display: block; height: 130px; margin: 16px 0;
  background: var(--vp-c-bg-soft); border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
}
.device-gallery [hidden] { display: none; }
.device-icon::before {
  content: ""; display: block; height: calc(100% - 44px); margin: 22px;
  background: var(--vp-c-text-1);
  mask: var(--icon) center / contain no-repeat;
}
.device-gallery figcaption {
  margin-top: 8px; font-size: 13px; line-height: 1.3; color: var(--vp-c-text-1);
}
.device-gallery figcaption .model {
  display: block; font-size: 11px; color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
}
</style>
