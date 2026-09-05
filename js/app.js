document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => { if (e.keyCode === 123 || (e.ctrlKey && e.shiftKey && (e.keyCode === 73 || e.keyCode === 74)) || (e.ctrlKey && (e.keyCode === 85 || e.keyCode === 83))) e.preventDefault(); });

const SUPABASE_URL = "https://sazdesulrndmyluqiyie.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_s2uJAXTsqj1JkVRZrBHFFA_3KsyTEEC";
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let map, activeStation = null, userLocationMarker = null, userAccuracyCircle = null, userCoords = null;
let rawStationData = [], allMarkers = [], groups = {}, currentCorridorSites = [];
let masterCategories = {}, masterConfigs = {}, excludedSitesList = [];
let offcanvasObj = null, lightboxModalObj = null, expeditionModalObj = null, pdfModalObj = null, expeditionGoogleMapsUrl = "";

document.addEventListener('DOMContentLoaded', async () => {
  offcanvasObj = new bootstrap.Offcanvas(document.getElementById('detailOffcanvas'));
  lightboxModalObj = new bootstrap.Modal(document.getElementById('imageLightboxModal'));
  expeditionModalObj = new bootstrap.Modal(document.getElementById('expeditionModal'));
  
  const pdfModalEl = document.getElementById('pdfReportModal');
  if (pdfModalEl) pdfModalObj = new bootstrap.Modal(pdfModalEl);

  if (window.innerWidth >= 992) {
    document.getElementById('statsBoxBody').style.display = 'block';
    document.getElementById('statsToggleIcon').className = 'fa-solid fa-chevron-up text-muted';
  }

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appScreen').style.display = 'block';
    await loadDatabaseMasterData();
    initMap(); 
    loadStationsFromDatabase();
  }
});

async function loadDatabaseMasterData() {
  let { data: configs } = await supabaseClient.from('app_config').select('*');
  if (configs) {
    configs.forEach(c => masterConfigs[c.key] = c.value);
    if (masterConfigs.app_title) {
      document.getElementById('loginAppTitle').innerText = masterConfigs.app_title;
      document.getElementById('navAppTitle').innerText = masterConfigs.app_title;
    }
    if (masterConfigs.app_subtitle) {
      document.getElementById('loginAppSubTitle').innerText = masterConfigs.app_subtitle;
      document.getElementById('navAppSubTitle').innerHTML = `<i class="fa-solid fa-circle text-success me-1" style="font-size: 7px;"></i> ${masterConfigs.app_subtitle}`;
    }
    if (masterConfigs.excluded_expedition_sites) {
      excludedSitesList = masterConfigs.excluded_expedition_sites.split(',').map(s => s.trim().toUpperCase());
    }
  }

  let { data: categories } = await supabaseClient.from('kategori_aloptama').select('*');
  const floatContainer = document.getElementById('floatingStatsContainer');
  floatContainer.innerHTML = `<div class="stat-card-float card-all" onclick="resetFilter()"><div class="stat-title">TOTAL</div><div class="stat-val mono" id="count-total">0</div></div>`;

  if (categories) {
    categories.forEach(cat => {
      masterCategories[cat.kategori_id] = cat;
      floatContainer.innerHTML += `
        <div class="stat-card-float" style="border-left: 3.5px solid ${cat.warna_hex}" onclick="toggleLayerFilter('${cat.kategori_id}')">
          <div class="stat-title">${cat.nama_kategori}</div>
          <div class="stat-val mono" id="count-${cat.kategori_id}">0</div>
        </div>`;
    });
  }

  let { data: reasons } = await supabaseClient.from('master_penyebab_mati').select('*').eq('is_active', true);
  const bypassSelect = document.getElementById('bypassReason');
  bypassSelect.innerHTML = '';
  if (reasons) reasons.forEach(r => bypassSelect.innerHTML += `<option value="${r.label_alasan}">${r.label_alasan}</option>`);

  let { data: radiuses } = await supabaseClient.from('master_radius_ekspedisi').select('*');
  const radiusSelect = document.getElementById('selectCorridorRadius');
  radiusSelect.innerHTML = '';
  if (radiuses) radiuses.forEach(r => radiusSelect.innerHTML += `<option value="${r.radius_km}" ${r.is_default ? 'selected' : ''}>${r.label_opsi}</option>`);
}

async function handleLogin(e) {
  e.preventDefault();
  const { error } = await supabaseClient.auth.signInWithPassword({ email: document.getElementById('loginEmail').value, password: document.getElementById('loginPassword').value });
  if (error) alert("Login Gagal: " + error.message); else location.reload();
}
async function handleLogout() { await supabaseClient.auth.signOut(); location.reload(); }

function initMap() {
  const defaultLat = parseFloat(masterConfigs.map_default_lat || 2.5);
  const defaultLng = parseFloat(masterConfigs.map_default_lng || 99.2);
  const defaultZoom = parseInt(masterConfigs.map_default_zoom || 7);

  map = L.map('map', { center: [defaultLat, defaultLng], zoom: defaultZoom, layers: [L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 })], zoomControl: false });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  
  Object.keys(masterCategories).forEach(k => { groups[k] = L.layerGroup().addTo(map); });
  groups['off'] = L.layerGroup();
}

function getHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function updateCountText(elementId, val) {
  const el = document.getElementById(elementId);
  if (el) el.innerText = val;
}

async function loadStationsFromDatabase() {
  let { data: stasiun } = await supabaseClient.from('stasiun').select('*');
  let { data: viewStats } = await supabaseClient.from('v_statistik_aloptama').select('*');
  if (!stasiun) return;

  rawStationData = stasiun; allMarkers = [];
  Object.keys(groups).forEach(k => groups[k].clearLayers());

  let counts = { total: stasiun.length, up: 0, down: 0 };
  const selectDest = document.getElementById('selectDestinationSite'), selectManual = document.getElementById('selectManualSite');
  selectDest.innerHTML = '<option value="">-- Pilih Stasiun Tujuan --</option>';
  selectManual.innerHTML = '<option value="">-- Pilih Site Untuk Disisipkan --</option>';

  stasiun.forEach(item => {
    const isUp = item.status !== 'OFF';
    isUp ? counts.up++ : counts.down++;

    if (!excludedSitesList.includes(item.id.toUpperCase())) {
      const opt = `<option value="${item.id}">${item.nama} [${item.kategori.toUpperCase()}] ${!isUp ? '(OFF)' : ''}</option>`;
      selectDest.innerHTML += opt; selectManual.innerHTML += opt;
    }

    const catMeta = masterCategories[item.kategori] || { fa_icon: 'fa-location-dot', warna_hex: '#38bdf8', size_x: 24, size_y: 24 };
    const iconHtml = `<div style="background:${catMeta.warna_hex}; color:white; width:${catMeta.size_x}px; height:${catMeta.size_y}px; border-radius:5px; display:flex; align-items:center; justify-content:center; border:2px solid white; box-shadow:0 0 6px ${catMeta.warna_hex};"><i class="fa-solid ${catMeta.fa_icon}"></i></div>`;

    const icon = L.divIcon({ className: 'custom-marker', html: iconHtml, iconSize: [catMeta.size_x, catMeta.size_y], iconAnchor: [catMeta.size_x/2, catMeta.size_y/2] });
    const marker = L.marker([item.lat, item.lng], { icon }).on('click', () => { activeStation = item; openDetailPanel(item); map.flyTo([item.lat, item.lng], 13); });

    if (groups[item.kategori]) marker.addTo(groups[item.kategori]);
    if (!isUp) marker.addTo(groups['off']);
    allMarkers.push({ title: item.nama.toLowerCase(), marker, data: item, group: groups[item.kategori] });
  });

  updateCountText('count-total', counts.total);
  updateCountText('tbl-total', counts.total);
  updateCountText('tbl-up', counts.up);
  updateCountText('tbl-down', counts.down);
  updateCountText('tbl-priority-total', `${counts.down} SITE`);
  updateCountText('tbl-percent', `${((counts.up / counts.total) * 100).toFixed(1)}%`);

  const tbody = document.getElementById('tbl-detail-rows'); tbody.innerHTML = '';
  Object.keys(masterCategories).forEach(k => {
    const stat = (viewStats || []).find(v => v.kategori === k) || { total: 0, up: 0, down: 0, prio: 0, active_pct: 0 };
    updateCountText(`count-${k}`, stat.total || 0);
    tbody.innerHTML += `<tr><td>${masterCategories[k].nama_kategori}</td><td>${stat.total||0}</td><td class="text-success">${stat.up||0}</td><td class="text-danger">${stat.down||0}</td><td class="text-danger">${stat.prio||0}</td><td class="text-info">${stat.active_pct||0}%</td></tr>`;
  });
}

function openDetailPanel(item) {
  document.getElementById('panelTitle').innerText = item.nama;
  document.getElementById('panelCategory').innerText = item.kategori.toUpperCase();
  document.getElementById('panelCoords').innerText = `${item.lat}, ${item.lng}`;
  document.getElementById('panelNav').href = `https://www.google.com/maps/dir/?api=1&destination=${item.lat},${item.lng}`;
  
  const badge = document.getElementById('panelStatusBadge');
  badge.innerText = item.status || 'ON'; badge.className = `badge ${item.status === 'OFF' ? 'bg-danger' : 'bg-success'} fw-bold`;

  const picCard = document.getElementById('picCardSection');
  const picNameEl = document.getElementById('valPicName');
  const waBtn = document.getElementById('btnWaPic');

  if (item.pic_wa) {
    let cleanWa = item.pic_wa.replace(/[^0-9]/g, '');
    if (cleanWa.startsWith('0')) cleanWa = '62' + cleanWa.slice(1);

    const message = encodeURIComponent(`Halo ${item.pic_nama || 'PIC'}, saya Teknisi BMKG ingin mengonfirmasi terkait stasiun ${item.nama} (${item.id}).`);
    picNameEl.innerText = item.pic_nama || 'PIC Lapangan';
    waBtn.href = `https://wa.me/${cleanWa}?text=${message}`;
    picCard.style.display = 'block';
  } else {
    picCard.style.display = 'none';
  }

  document.getElementById('valLastVisit').innerText = item.kunjungan_terakhir || 'Belum ada record';
  document.getElementById('valActivity').innerText = item.kegiatan || '-';
  document.getElementById('valNotes').innerText = item.catatan || '-';
  document.getElementById('valRecs').innerText = item.rekomendasi || '-';

  const nearbyContainer = document.getElementById('nearbySitesContainer'); nearbyContainer.innerHTML = '';
  rawStationData.filter(s => s.id !== item.id).map(s => ({ ...s, dist: getHaversineDistance(item.lat, item.lng, s.lat, s.lng) })).sort((a, b) => a.dist - b.dist).slice(0, 3).forEach(ns => {
    nearbyContainer.innerHTML += `<div class="list-group-item bg-dark text-white border-secondary p-1 px-2 d-flex justify-content-between align-items-center mb-1 rounded" style="cursor:pointer;" onclick="focusToSite('${ns.id}')"><div><strong>${ns.nama}</strong> <small class="text-muted d-block" style="font-size:9px;">Jarak: ±${ns.dist.toFixed(1)} km</small></div><span class="badge ${ns.status === 'OFF' ? 'bg-danger' : 'bg-success'}">${ns.status||'ON'}</span></div>`;
  });

  const galleryEl = document.getElementById('docGallery'), noImgEl = document.getElementById('noImgText'); galleryEl.innerHTML = '';
  let photos = Array.isArray(item.foto_urls) ? item.foto_urls : [];
  if (photos.length) {
    photos.forEach(url => {
      const img = document.createElement('img'); img.src = url; img.className = 'doc-img-item border border-secondary'; img.onclick = () => openLightboxImage(url); galleryEl.appendChild(img);
    });
    galleryEl.style.display = 'grid'; noImgEl.style.display = 'none';
  } else { galleryEl.style.display = 'none'; noImgEl.style.display = 'inline'; }

  const offBox = document.getElementById('offReportSection');
  if (item.status === 'OFF' && item.tgl_laporan_mati) {
    document.getElementById('valOffDate').innerText = item.tgl_laporan_mati; document.getElementById('valOffReason').innerText = item.penyebab_mati || '-'; document.getElementById('valOffNotes').innerText = item.troubleshoot_mati || '-'; offBox.style.display = 'block';
  } else offBox.style.display = 'none';

  document.getElementById('formStatus').value = item.status || 'ON'; document.getElementById('formDate').value = item.kunjungan_terakhir || new Date().toISOString().split('T')[0];
  offcanvasObj.show();
}

function planMultiSiteRoute() {
  const offSites = allMarkers.filter(m => m.data.status === 'OFF' && !excludedSitesList.includes(m.data.id.toUpperCase())).map(m => m.data);
  if (!offSites.length) return alert("✅ Tidak ada stasiun luar yang bermasalah (OFF)!");
  if (!userCoords) return locateUser();

  let currentLat = userCoords.lat, currentLng = userCoords.lng, sortedSites = [], remainingSites = [...offSites];
  while (remainingSites.length) {
    remainingSites.sort((a, b) => getHaversineDistance(currentLat, currentLng, a.lat, a.lng) - getHaversineDistance(currentLat, currentLng, b.lat, b.lng));
    let nearest = remainingSites.shift(); sortedSites.push(nearest);
    currentLat = nearest.lat; currentLng = nearest.lng;
  }

  let waypoints = sortedSites.slice(0, -1).map(s => `${s.lat},${s.lng}`).join('|');
  let url = `https://www.google.com/maps/dir/?api=1&origin=${userCoords.lat},${userCoords.lng}&destination=${sortedSites.at(-1).lat},${sortedSites.at(-1).lng}`;
  if (waypoints) url += `&waypoints=${waypoints}`;
  window.open(url, '_blank');
}

function calculateExpeditionRoute() {
  const destId = document.getElementById('selectDestinationSite').value, radiusKm = parseFloat(document.getElementById('selectCorridorRadius').value), resBox = document.getElementById('expeditionResultBox');
  if (!destId) return resBox.style.display = 'none';

  if (!userCoords) {
    if (!navigator.geolocation) return alert("⚠️ GPS Tidak Didukung.");
    navigator.geolocation.getCurrentPosition(pos => { userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude }; calculateExpeditionRoute(); }, () => alert("⚠️ Harap izinkan akses GPS pada browser Anda."));
    return;
  }

  const destSite = rawStationData.find(s => s.id === destId);
  if (!destSite) return;

  currentCorridorSites = [];
  rawStationData.forEach(site => {
    if (site.id === destSite.id || excludedSitesList.includes(site.id.toUpperCase())) return;
    let distFromStart = getHaversineDistance(userCoords.lat, userCoords.lng, site.lat, site.lng);
    let distToDest = getHaversineDistance(site.lat, site.lng, destSite.lat, destSite.lng);
    let directDist = getHaversineDistance(userCoords.lat, userCoords.lng, destSite.lat, destSite.lng);
    if ((distFromStart + distToDest - directDist) <= (radiusKm / 3)) currentCorridorSites.push({ ...site, distFromStart, selected: true, manual: false });
  });

  currentCorridorSites.sort((a, b) => a.distFromStart - b.distFromStart);
  renderExpeditionResults(destSite);
  resBox.style.display = 'block';
}

function addManualSiteToRoute() {
  const manualId = document.getElementById('selectManualSite').value, destId = document.getElementById('selectDestinationSite').value;
  if (!destId) return alert("📍 Silakan pilih Stasiun Akhir Tujuan Utama terlebih dahulu.");
  if (!manualId) return alert("📍 Silakan pilih site yang ingin disisipkan.");
  if (manualId === destId) return alert("⚠️ Site ini sudah dipilih sebagai Tujuan Utama.");

  const exists = currentCorridorSites.find(s => s.id === manualId);
  if (exists) exists.selected = true;
  else {
    const siteData = rawStationData.find(s => s.id === manualId);
    if (siteData) {
      currentCorridorSites.push({ ...siteData, distFromStart: getHaversineDistance(userCoords.lat, userCoords.lng, siteData.lat, siteData.lng), selected: true, manual: true });
      currentCorridorSites.sort((a, b) => a.distFromStart - b.distFromStart);
    }
  }
  renderExpeditionResults(rawStationData.find(s => s.id === destId));
  document.getElementById('selectManualSite').value = "";
}

function renderExpeditionResults(destSite) {
  const activeCorridorSites = currentCorridorSites.filter(s => s.selected);
  const totalVisitedSites = activeCorridorSites.length + 1;

  let totalDistKm = 0, currLat = userCoords.lat, currLng = userCoords.lng;
  activeCorridorSites.forEach(s => { totalDistKm += getHaversineDistance(currLat, currLng, s.lat, s.lng); currLat = s.lat; currLng = s.lng; });
  totalDistKm += getHaversineDistance(currLat, currLng, destSite.lat, destSite.lng);

  const avgSpeed = parseFloat(masterConfigs.avg_speed_km_per_day || 200);
  let travelDays = Math.ceil(totalDistKm / avgSpeed), totalEstimDays = totalVisitedSites + (travelDays > 1 ? travelDays - 1 : 0);

  document.getElementById('resSiteCount').innerText = `${totalVisitedSites} Site (${activeCorridorSites.length} Singgah + 1 Tujuan)`;
  document.getElementById('resTotalDistance').innerText = `±${Math.round(totalDistKm)} km`;
  document.getElementById('resEstimDays').innerText = `${totalEstimDays} Hari Kerja`;

  const listEl = document.getElementById('resSiteList'); listEl.innerHTML = '';
  currentCorridorSites.forEach((s) => {
    listEl.innerHTML += `<div class="list-group-item bg-dark text-white border-secondary p-1 px-2 d-flex justify-content-between align-items-center mb-1 rounded"><div class="form-check m-0"><input class="form-check-input" type="checkbox" id="chk_${s.id}" ${s.selected ? 'checked' : ''} onchange="toggleSiteSelection('${s.id}')"><label class="form-check-label small" for="chk_${s.id}">${s.nama} ${s.manual ? '<span class="text-info">(Sisipan Manual)</span>' : ''}</label></div><span class="badge ${s.status === 'OFF' ? 'bg-danger' : 'bg-success'}">${s.status||'ON'}</span></div>`;
  });
  listEl.innerHTML += `<div class="list-group-item bg-dark text-info border-info p-1 px-2 d-flex justify-content-between align-items-center fw-bold rounded"><span>🎯 ${destSite.nama} (Tujuan Utama)</span> <span class="badge ${destSite.status === 'OFF' ? 'bg-danger' : 'bg-success'}">${destSite.status||'ON'}</span></div>`;

  let waypoints = activeCorridorSites.map(s => `${s.lat},${s.lng}`).join('|');
  expeditionGoogleMapsUrl = `https://www.google.com/maps/dir/?api=1&origin=${userCoords.lat},${userCoords.lng}&destination=${destSite.lat},${destSite.lng}`;
  if (waypoints) expeditionGoogleMapsUrl += `&waypoints=${waypoints}`;
}

function toggleSiteSelection(siteId) {
  const site = currentCorridorSites.find(s => s.id === siteId);
  if (site) { site.selected = !site.selected; renderExpeditionResults(rawStationData.find(s => s.id === document.getElementById('selectDestinationSite').value)); }
}

function openExpeditionGoogleMaps() { if (expeditionGoogleMapsUrl) window.open(expeditionGoogleMapsUrl, '_blank'); }

async function saveBypassOffReport(e) {
  e.preventDefault(); if (!activeStation) return;
  await supabaseClient.rpc('rpc_save_bypass_off', { p_id: activeStation.id, p_reason: document.getElementById('bypassReason').value, p_notes: document.getElementById('bypassNotes').value });
  alert("⚠️ LAPORAN ALAT MATI TERSIMPAN!"); loadStationsFromDatabase(); closePanel();
}

async function saveReportToDatabase(e) {
  e.preventDefault(); if (!activeStation) return;
  const btnSubmit = document.getElementById('btnSubmitForm'); btnSubmit.disabled = true; btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> Mengunggah...';

  let existingPhotos = Array.isArray(activeStation.foto_urls) ? activeStation.foto_urls : [];
  const fileInput = document.getElementById('formPhoto');

  if (fileInput.files.length > 0) {
    for (let i = 0; i < fileInput.files.length; i++) {
      const file = fileInput.files[i], fileName = `${activeStation.id}_${Date.now()}_${i}.${file.name.split('.').pop()}`;
      const { error } = await supabaseClient.storage.from('dokumentasi').upload(fileName, file, { upsert: true });
      if (!error) existingPhotos.push(supabaseClient.storage.from('dokumentasi').getPublicUrl(fileName).data.publicUrl);
    }
  }

  await supabaseClient.rpc('rpc_save_maintenance_log', { p_id: activeStation.id, p_status: document.getElementById('formStatus').value, p_date: document.getElementById('formDate').value, p_activity: document.getElementById('formActivity').value, p_notes: document.getElementById('formNotes').value, p_recs: document.getElementById('formRecs').value });
  await supabaseClient.from('stasiun').update({ foto_urls: existingPhotos }).eq('id', activeStation.id);

  btnSubmit.disabled = false; btnSubmit.innerHTML = '<i class="fa-solid fa-cloud-arrow-up me-1"></i> Commit Data Ke Database';
  alert("✅ LOG MAINTENANCE BERHASIL DISIMPAN!"); fileInput.value = ""; loadStationsFromDatabase(); closePanel();
}

function locateUser() {
  const btn = document.getElementById('btnLocateUser'); btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> Melacak...';
  if (!navigator.geolocation) return alert("⚠️ GPS Tidak Didukung.");

  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords; userCoords = { lat, lng };
    if (userLocationMarker) map.removeLayer(userLocationMarker);
    if (userAccuracyCircle) map.removeLayer(userAccuracyCircle);

    userLocationMarker = L.marker([lat, lng], { icon: L.divIcon({ className: 'custom-marker', html: '<div style="background:#2563eb; color:white; width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; border:2px solid white; box-shadow:0 0 10px #2563eb;"><i class="fa-solid fa-user-gear"></i></div>', iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(map);
    userAccuracyCircle = L.circle([lat, lng], { radius: accuracy, color: '#38bdf8', fillColor: '#38bdf8', fillOpacity: 0.15, weight: 1 }).addTo(map);

    userLocationMarker.bindPopup(`<b>📍 Lokasi Teknisi Lapangan</b><br>Lat: ${lat.toFixed(6)}, Lng: ${lng.toFixed(6)}<br><small style="color:#38bdf8;">Toleransi: ±${Math.round(accuracy)} meter</small>`).openPopup();
    map.flyTo([lat, lng], 15); btn.innerHTML = '<i class="fa-solid fa-crosshairs me-1"></i> Posisi Saya';
  }, () => { alert("⚠️ Gagal melacak posisi GPS."); btn.innerHTML = '<i class="fa-solid fa-crosshairs me-1"></i> Posisi Saya'; }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}

function openLightboxImage(url) { document.getElementById('lightboxImage').src = url; lightboxModalObj.show(); }

function focusToSite(siteId) {
  const match = allMarkers.find(m => m.data.id === siteId);
  if (match) { if (!map.hasLayer(match.group)) match.group.addTo(map); map.flyTo([match.data.lat, match.data.lng], 13); match.marker.fire('click'); }
}

function filterByPriority() { hideAllLayers(); map.addLayer(groups['off']); closePanel(); const offM = allMarkers.filter(m => m.data.status === 'OFF'); if (offM.length) map.fitBounds(L.latLngBounds(offM.map(m => m.marker.getLatLng())), { padding: [30, 30] }); }
function hideAllLayers() { Object.keys(groups).forEach(k => map.removeLayer(groups[k])); }
function resetFilter() { hideAllLayers(); Object.keys(masterCategories).forEach(k => map.addLayer(groups[k])); map.setView([parseFloat(masterConfigs.map_default_lat||2.5), parseFloat(masterConfigs.map_default_lng||99.2)], parseInt(masterConfigs.map_default_zoom||7)); closePanel(); }
function toggleLayerFilter(type) { hideAllLayers(); if (groups[type]) map.addLayer(groups[type]); closePanel(); }
function closePanel() { if (offcanvasObj) offcanvasObj.hide(); activeStation = null; }
function toggleStatsBox() { 
  const b = document.getElementById('statsBoxBody');
  const icon = document.getElementById('statsToggleIcon');
  if (b.style.display === 'none') {
    b.style.display = 'block';
    icon.className = 'fa-solid fa-chevron-up text-muted';
  } else {
    b.style.display = 'none';
    icon.className = 'fa-solid fa-chevron-down text-muted';
  }
}
function searchStation() { const q = document.getElementById('searchInput').value.toLowerCase().trim(); if (!q) return; const match = allMarkers.find(m => m.title.includes(q)); if (match) { if (!map.hasLayer(match.group)) match.group.addTo(map); map.flyTo([match.data.lat, match.data.lng], 13); match.marker.fire('click'); } }

// ============================================================
// MODUL CETAK LAPORAN ALOPTAMA PDF (DINAMIS DARI DATABASE aloptama)
// ============================================================
async function generateAloptamaPDF(e) {
  e.preventDefault();
  
  const noSurat = document.getElementById('pdfNoSurat').value;
  const tanggalRaw = document.getElementById('pdfTanggal').value;
  const lampiran = document.getElementById('pdfLampiran').value;
  const tujuan = document.getElementById('pdfTujuan').value;
  const namaKepala = document.getElementById('pdfNamaKepala').value;
  const nipKepala = document.getElementById('pdfNipKepala').value;
  const tembusanStr = document.getElementById('pdfTembusan').value;

  const dateObj = new Date(tanggalRaw);
  const bulanIndo = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  const tglFormatted = `${dateObj.getDate()} ${bulanIndo[dateObj.getMonth()]} ${dateObj.getFullYear()}`;

  // 1. Tarik Data Terpisah Dari Tabel data_aloptama
  let { data: items, error } = await supabaseClient.from('data_aloptama').select('*').order('id', { ascending: true });
  
  if (error || !items) {
    alert("⚠️ Gagal mengambil data aloptama dari database: " + (error ? error.message : "Data Kosong"));
    return;
  }

  // 2. Kelompokkan Data Berdasarkan Kategori
  const groupedData = {};
  items.forEach(item => {
    if (!groupedData[item.kategori]) groupedData[item.kategori] = [];
    groupedData[item.kategori].push(item);
  });

  // 3. Susun Tembusan
  const arrTembusan = tembusanStr.split(',').map(t => `<li>${t.trim()}</li>`).join('');

  // 4. Render HTML Tabel Berdasarkan Kategori
  let htmlTables = '';
  let catIndex = 1;

  for (const [kategoriName, rows] of Object.entries(groupedData)) {
    let isSiteTable = kategoriName.toLowerCase().includes('site') || kategoriName.toLowerCase().includes('wrs');
    
    htmlTables += `
      <div style="margin-top: 15px; page-break-inside: avoid;">
        <h4 style="font-size: 10pt; font-weight: bold; margin-bottom: 4px; text-transform: uppercase;">
          ${catIndex}. ${kategoriName}
        </h4>
        <table style="width: 100%; border-collapse: collapse; font-size: 8.5pt;">
          <thead>
            <tr style="background-color: #f2f2f2; text-align: center;">
              <th style="border: 1px solid #000; padding: 4px; width: 30px;">No</th>
              ${isSiteTable ? `
                <th style="border: 1px solid #000; padding: 4px;">Nama Site / Lokasi</th>
                <th style="border: 1px solid #000; padding: 4px;">Kabupaten / Kota</th>
                <th style="border: 1px solid #000; padding: 4px;">Tipe Alat</th>
                <th style="border: 1px solid #000; padding: 4px;">Kondisi</th>
                <th style="border: 1px solid #000; padding: 4px;">Keterangan</th>
              ` : `
                <th style="border: 1px solid #000; padding: 4px;">Nama Alat</th>
                <th style="border: 1px solid #000; padding: 4px;">Merk</th>
                <th style="border: 1px solid #000; padding: 4px;">Tipe</th>
                <th style="border: 1px solid #000; padding: 4px;">No Seri</th>
                <th style="border: 1px solid #000; padding: 4px;">Tahun</th>
                <th style="border: 1px solid #000; padding: 4px;">Kondisi</th>
                <th style="border: 1px solid #000; padding: 4px;">Keterangan</th>
              `}
            </tr>
          </thead>
          <tbody>
            ${rows.map((r, i) => `
              <tr>
                <td style="border: 1px solid #000; padding: 4px; text-align: center;">${r.no_alat || (i + 1)}</td>
                ${isSiteTable ? `
                  <td style="border: 1px solid #000; padding: 4px;">${r.nama_alat_site || '-'} <br><small style="color:#555;">${r.lokasi || ''}</small></td>
                  <td style="border: 1px solid #000; padding: 4px;">${r.kabupaten_kota || '-'}</td>
                  <td style="border: 1px solid #000; padding: 4px;">${r.tipe || '-'}</td>
                  <td style="border: 1px solid #000; padding: 4px; text-align: center;">${r.kondisi || '-'}</td>
                  <td style="border: 1px solid #000; padding: 4px;">${r.keterangan || '-'}</td>
                ` : `
                  <td style="border: 1px solid #000; padding: 4px;">${r.nama_alat_site || '-'}</td>
                  <td style="border: 1px solid #000; padding: 4px;">${r.merk || '-'}</td>
                  <td style="border: 1px solid #000; padding: 4px;">${r.tipe || '-'}</td>
                  <td style="border: 1px solid #000; padding: 4px;">${r.no_seri || '-'}</td>
                  <td style="border: 1px solid #000; padding: 4px; text-align: center;">${r.tahun_pengadaan || '-'}</td>
                  <td style="border: 1px solid #000; padding: 4px; text-align: center;">${r.kondisi || '-'}</td>
                  <td style="border: 1px solid #000; padding: 4px;">${r.keterangan || '-'}</td>
                `}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
    catIndex++;
  }

  // 5. Susun Layout Lengkap Surat & KOP
  const printContent = `
    <div id="pdfPrintArea" style="font-family: Arial, sans-serif; color: #000; padding: 10mm; background: #fff;">
      <table style="width: 100%; border-bottom: 3px double #000; padding-bottom: 6px; margin-bottom: 12px;">
        <tr>
          <td style="width: 12%; text-align: center;">
            <img src="https://www.bmkg.go.id/asset/img/logo/logo-bmkg.png" style="width: 65px; height: auto;">
          </td>
          <td style="text-align: center;">
            <strong style="font-size: 11pt; display: block; text-transform: uppercase;">BADAN METEOROLOGI, KLIMATOLOGI, DAN GEOFISIKA</strong>
            <strong style="font-size: 12pt; display: block; text-transform: uppercase;">STASIUN GEOFISIKA KELAS I DELI SERDANG</strong>
            <span style="font-size: 8pt; display: block;">Jln. Geofisika No. 1 Tuntungan I, Pancur Batu - Deli Serdang Kode Pos 20353</span>
            <span style="font-size: 8pt; display: block;">Email: stageof.deliserdang@bmkg.go.id</span>
          </td>
        </tr>
      </table>

      <table style="width: 100%; font-size: 9.5pt; margin-bottom: 15px;">
        <tr>
          <td style="width: 10%;">Nomor</td>
          <td style="width: 2%;">:</td>
          <td style="width: 48%;">${noSurat}</td>
          <td style="width: 40%; text-align: right;">Deli Serdang, ${tglFormatted}</td>
        </tr>
        <tr>
          <td>Lampiran</td>
          <td>:</td>
          <td>${lampiran}</td>
          <td></td>
        </tr>
        <tr>
          <td>Hal</td>
          <td>:</td>
          <td><strong>Laporan Kondisi Aloptama Stasiun Geofisika Deli Serdang</strong></td>
          <td>Yth. ${tujuan}<br>di Jakarta</td>
        </tr>
      </table>

      <p style="font-size: 9.5pt; text-align: justify; line-height: 1.4;">
        Bersama ini kami laporkan Kondisi Aloptama per tanggal <strong>${tglFormatted}</strong> yang menjadi tanggung jawab Stasiun Geofisika Kelas I Deli Serdang.
      </p>

      <div style="text-align: center; margin: 15px 0 5px 0;">
        <strong style="font-size: 10pt; text-transform: uppercase;">LAPORAN KONDISI ALOPTAMA</strong><br>
        <strong style="font-size: 10pt; text-transform: uppercase;">STASIUN GEOFISIKA KELAS I DELI SERDANG</strong><br>
        <span style="font-size: 9pt;">Per Tanggal ${tglFormatted}</span>
      </div>

      ${htmlTables}

      <div style="margin-top: 30px; page-break-inside: avoid;">
        <table style="width: 100%; font-size: 9.5pt;">
          <tr>
            <td style="width: 50%;">
              Tembusan:<br>
              <ol style="margin: 0; padding-left: 18px;">
                ${arrTembusan}
              </ol>
            </td>
            <td style="width: 50%; text-align: center; vertical-align: top;">
              Deli Serdang, ${tglFormatted}<br>
              Kepala Stasiun Geofisika Kelas I Deli Serdang<br>
              <br><br><br>
              <strong>${namaKepala}</strong>
              ${nipKepala ? `<br>NIP. ${nipKepala}` : ''}
            </td>
          </tr>
        </table>
      </div>
    </div>
  `;

  if (pdfModalObj) pdfModalObj.hide();

  let win = window.open('', '_blank');
  win.document.write(`
    <html>
      <head>
        <title>Laporan Kondisi Aloptama ${tglFormatted}</title>
        <style>
          @page { size: A4 portrait; margin: 8mm; }
          body { margin: 0; padding: 0; background: #fff; }
        </style>
      </head>
      <body>
        ${printContent}
      </body>
    </html>
  `);
  win.document.close();
  setTimeout(() => {
    win.focus();
    win.print();
  }, 500);
}
