/**
 * Ruttplaneraren - Smart Ruttoptimering för budbilar
 * Core Application Logic
 */

// ==========================================================================
// 1. APPLICATION STATE
// ==========================================================================
const state = {
  warehouse: null,       // { address: string, lat: number, lon: number }
  defaultCity: "Halmstad",
  stopTime: 3,           // stop processing time in minutes
  lockWarehouse: true,   // Pin warehouse at start & end
  stops: [],             // Array of stops: { id, address, lat, lon, status, cargoLoaded }
  activeTab: "planera",  // planera, lastlista, korlage
  currentStopIndex: 0,   // Current target stop index in Körläge
  pinnedStartStopId: null, // Pinned first delivery stop
  pinnedEndStopId: null,   // Pinned last delivery stop
};

// Map instances
let map = null;
let routeLine = null;
let markersGroup = null;

let mapPlanera = null;
let planeraRouteLine = null;
let planeraMarkersGroup = null;

// Drag and drop state
let dragSrcEl = null;

// ==========================================================================
// 2. INITIALIZATION
// ==========================================================================
document.addEventListener("DOMContentLoaded", () => {
  loadStateFromStorage();
  initTabs();
  initSettingsPanel();
  initForms();
  initDragAndDrop();
  initModals();
  
  // Register Service Worker for PWA
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js")
        .then(reg => console.log("[Service Worker] Registered successfully"))
        .catch(err => console.error("[Service Worker] Registration failed", err));
    });
  }

  // Draw UI and initialize maps on startup
  renderAll();
  setTimeout(initPlaneraMap, 100);
});

// Load state from localStorage
function loadStateFromStorage() {
  const savedState = localStorage.getItem("ruttplaneraren_state");
  if (savedState) {
    try {
      const parsed = JSON.parse(savedState);
      state.warehouse = parsed.warehouse || null;
      state.defaultCity = parsed.defaultCity || "Halmstad";
      state.stopTime = Number(parsed.stopTime) || 3;
      state.lockWarehouse = parsed.lockWarehouse !== undefined ? parsed.lockWarehouse : true;
      state.stops = parsed.stops || [];
      state.currentStopIndex = parsed.currentStopIndex !== undefined ? parsed.currentStopIndex : 0;
      state.pinnedStartStopId = parsed.pinnedStartStopId || null;
      state.pinnedEndStopId = parsed.pinnedEndStopId || null;
    } catch (e) {
      console.error("Kunde inte läsa sparat tillstånd från localStorage", e);
    }
  }
}

// Save state to localStorage
function saveStateToStorage() {
  localStorage.setItem("ruttplaneraren_state", JSON.stringify(state));
}

// ==========================================================================
// 3. UI RENDERING & ROUTERS
// ==========================================================================
function renderAll() {
  // Update Config Inputs
  document.getElementById("warehouse-input").value = state.warehouse ? state.warehouse.address : "";
  document.getElementById("default-city-input").value = state.defaultCity;
  document.getElementById("stop-time-input").value = state.stopTime;
  document.getElementById("lock-warehouse-switch").checked = state.lockWarehouse;
  document.getElementById("helper-city-text").textContent = state.defaultCity;
  
  const warehouseStatus = document.getElementById("warehouse-status");
  if (state.warehouse) {
    warehouseStatus.innerHTML = `<span class="icon-emerald">✓ Lager sparat:</span> ${state.warehouse.address}`;
    warehouseStatus.style.color = "var(--accent-emerald)";
  } else {
    warehouseStatus.textContent = "Inget lager sparat. Rutten kräver en startpunkt.";
    warehouseStatus.style.color = "var(--accent-orange)";
  }

  // Render Page Views based on Active Tab
  renderPlaneraView();
  renderLastlistaView();
  renderKorlageView();
  
  // Recalculate dynamic stats and update header ETA
  updateGlobalETAEngine();
  
  saveStateToStorage();
}

// Tab Switching Mechanism
function initTabs() {
  const navButtons = document.querySelectorAll(".app-nav .nav-btn");
  const views = document.querySelectorAll(".app-content .view-section");

  navButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetTab = btn.id.replace("nav-", "");
      state.activeTab = targetTab;
      
      // Update UI active tab state
      navButtons.forEach(b => b.classList.remove("active"));
      views.forEach(v => v.classList.remove("active"));
      
      btn.classList.add("active");
      const targetView = document.getElementById(`view-${targetTab}`);
      if (targetView) targetView.classList.add("active");
      
      // If switching to Körläge or Planera, instantiate or update Map
      if (targetTab === "korlage") {
        setTimeout(initLeafletMap, 100);
      } else if (targetTab === "planera") {
        setTimeout(initPlaneraMap, 100);
      }
      
      renderAll();
    });
  });
}

// Settings toggle card behavior
function initSettingsPanel() {
  const toggle = document.getElementById("settings-toggle");
  const body = document.getElementById("settings-body");
  const chevron = document.getElementById("settings-chevron");

  toggle.addEventListener("click", () => {
    body.classList.toggle("hidden");
    chevron.classList.toggle("rotated");
  });
}

// ==========================================================================
// 4. ADDRESS GEOCONDING & VALIDATION (NOMINATIM)
// ==========================================================================
function initForms() {
  // Default City Change
  document.getElementById("default-city-input").addEventListener("change", (e) => {
    state.defaultCity = e.target.value.trim() || "Halmstad";
    document.getElementById("helper-city-text").textContent = state.defaultCity;
    saveStateToStorage();
  });

  // Stop Time Change
  document.getElementById("stop-time-input").addEventListener("change", (e) => {
    state.stopTime = Math.max(1, Number(e.target.value) || 3);
    updateGlobalETAEngine();
    saveStateToStorage();
  });

  // Pin Warehouse Switch Change
  document.getElementById("lock-warehouse-switch").addEventListener("change", (e) => {
    state.lockWarehouse = e.target.checked;
    saveStateToStorage();
  });

  // Save Warehouse button click
  document.getElementById("save-warehouse-btn").addEventListener("click", async () => {
    const input = document.getElementById("warehouse-input");
    const address = input.value.trim();
    if (!address) {
      showSwedishModal("Valideringsfel", "Ange en giltig adress för lagret.");
      return;
    }
    
    // Auto append city if needed
    const formattedAddress = appendDefaultCityIfNeeded(address);
    input.value = formattedAddress;

    const btn = document.getElementById("save-warehouse-btn");
    btn.disabled = true;
    btn.textContent = "Söker...";

    try {
      const coords = await geocodeAddress(formattedAddress);
      if (coords) {
        state.warehouse = {
          address: formattedAddress,
          lat: coords.lat,
          lon: coords.lon
        };
        showSwedishModal("Lager sparad", `Lagret har placerats på kartan:<br><strong>${formattedAddress}</strong>`);
        calculateRouteGeometryAndStats().then(() => {
          renderAll();
          if (mapPlanera) updatePlaneraMapPathsAndMarkers();
          if (map) updateMapPathsAndMarkers();
        });
      } else {
        showSwedishModal("Adressen hittades inte", `Kunde inte verifiera adressen: <strong>"${formattedAddress}"</strong>. Kontrollera stavning eller postnummer.`);
      }
    } catch (e) {
      showSwedishModal("Systemfel", "Ett nätverksfel uppstod under adressverifieringen. Försök igen.");
    } finally {
      btn.disabled = false;
      btn.textContent = "Spara";
    }
  });

  // Add Delivery Address Form submit
  document.getElementById("add-address-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("address-input");
    const address = input.value.trim();
    if (!address) return;

    // Auto-append city if missing
    const formattedAddress = appendDefaultCityIfNeeded(address);

    // Duplicate Prevention check
    if (isDuplicateAddress(formattedAddress)) {
      showSwedishModal("Adressen finns redan", `Leveransen till <strong>"${formattedAddress}"</strong> är redan tillagd i ruttlistan.`);
      return;
    }

    const btn = document.getElementById("add-address-btn");
    const spinner = document.getElementById("geocode-spinner");
    
    btn.disabled = true;
    btn.querySelector(".btn-text").classList.add("hidden");
    spinner.classList.remove("hidden");

    try {
      const coords = await geocodeAddress(formattedAddress);
      if (coords) {
        // Successful Geocoding -> Add stop
        const newStop = {
          id: "stop_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
          address: formattedAddress,
          lat: coords.lat,
          lon: coords.lon,
          status: "pending",
          cargoLoaded: false,
          duration: 0 // Will be computed by router
        };
        
        state.stops.push(newStop);
        input.value = ""; // Clear input field
        calculateRouteGeometryAndStats().then(() => {
          renderAll();
          if (mapPlanera) updatePlaneraMapPathsAndMarkers();
          if (map) updateMapPathsAndMarkers();
        });
      } else {
        showSwedishModal("Adressen hittades inte", `Leveransadressen kunde inte verifieras:<br><strong>"${formattedAddress}"</strong>.<br><br>Säkerställ att gatunamn, husnummer och ort stämmer.`);
      }
    } catch (e) {
      showSwedishModal("Anslutningsfel", "Kunde inte kommunicera med adress-servern. Kontrollera din internetanslutning.");
    } finally {
      btn.disabled = false;
      btn.querySelector(".btn-text").classList.remove("hidden");
      spinner.classList.add("hidden");
    }
  });

  // Optimize Route Button
  document.getElementById("optimize-btn").addEventListener("click", () => {
    optimizeAndOrderRoute();
  });

  // Clean Route state
  document.getElementById("clear-route-btn").addEventListener("click", () => {
    showSwedishConfirmModal(
      "Rensa rutt?",
      "Detta kommer att ta bort ALLA inlagda leveransadresser och återställa dagens körpass. Är du säker?",
      () => {
        state.stops = [];
        state.currentStopIndex = 0;
        state.pinnedStartStopId = null;
        state.pinnedEndStopId = null;
        state.roadDistance = 0;
        state.roadDuration = 0;
        state.roadGeometry = null;
        renderAll();
        if (mapPlanera) updatePlaneraMapPathsAndMarkers();
        if (map) updateMapPathsAndMarkers();
      }
    );
  });
}

// Auto appends Default City to address if no Swedish city structure exists
function appendDefaultCityIfNeeded(address) {
  const zipPattern = /\b\d{3}\s?\d{2}\b/; // Swedish postcodes: 302 35 or 30235
  const hasComma = address.includes(",");
  const hasZip = zipPattern.test(address);
  const containsCity = address.toLowerCase().includes(state.defaultCity.toLowerCase());

  if (!hasComma && !hasZip && !containsCity) {
    return `${address}, ${state.defaultCity}`;
  }
  return address;
}

// Geocoding query using OpenStreetMap Nominatim
async function geocodeAddress(address) {
  const query = encodeURIComponent(address);
  // Restrict searches to Sweden (se) for faster and more accurate geocoding
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${query}&countrycodes=se&limit=1`;
  
  const response = await fetch(url, {
    headers: {
      "User-Agent": "RuttplanerarenDeliveryApp/1.0 (RasmusPC Sweden Delivery)"
    }
  });
  
  if (!response.ok) return null;
  const data = await response.json();
  if (data && data.length > 0) {
    return {
      lat: parseFloat(data[0].lat),
      lon: parseFloat(data[0].lon)
    };
  }
  return null;
}

// Checks if address matches normalized versions of existing stops or warehouse
function isDuplicateAddress(newAddress) {
  const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizedNew = normalize(newAddress);
  
  if (state.warehouse && normalize(state.warehouse.address) === normalizedNew) {
    return true;
  }
  return state.stops.some(stop => normalize(stop.address) === normalizedNew);
}

// ==========================================================================
// 5. TSP OPTIMIZATION (2-OPT + OSRM NETWORKING)
// ==========================================================================

// Calculate Spherical Haversine Distance (in km)
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Solves TSP using 2-opt search heuristic with optional start/end delivery pins
async function optimizeAndOrderRoute() {
  if (state.stops.length === 0) {
    showSwedishModal("Inga adresser", "Lägg till minst en leveransadress innan du optimerar rutten.");
    return;
  }
  if (!state.warehouse) {
    showSwedishModal("Saknar startlager", "Du måste konfigurera och spara ett Start-/Slutlager i inställningarna ovan först.");
    // Open settings card automatically to assist driver
    document.getElementById("settings-body").classList.remove("hidden");
    document.getElementById("settings-chevron").classList.add("rotated");
    return;
  }

  const optimizeBtn = document.getElementById("optimize-btn");
  optimizeBtn.disabled = true;
  optimizeBtn.textContent = "Optimerar rutt...";

  try {
    // 1. Resolve Pinned Stops from State
    const startStop = state.stops.find(s => s.id === state.pinnedStartStopId);
    const endStop = state.stops.find(s => s.id === state.pinnedEndStopId);
    
    // Filter intermediate stops (all deliveries except the pinned ones)
    let intermediates = state.stops.filter(s => s.id !== state.pinnedStartStopId && s.id !== state.pinnedEndStopId);
    
    let finalSequence = [];
    
    // Determine start and end anchors for intermediate optimization
    const startAnchor = startStop ? startStop : state.warehouse;
    const endAnchor = endStop ? endStop : state.warehouse;
    
    // Optimize intermediate stops between anchors
    let optimizedIntermediates = solveTSPWithOptionalPins(startAnchor, endAnchor, intermediates);
    
    // Assemble final sequence
    if (startStop) finalSequence.push(startStop);
    finalSequence.push(...optimizedIntermediates);
    if (endStop) finalSequence.push(endStop);
    
    state.stops = finalSequence;
    state.currentStopIndex = 0; // Reset progress back to start since route changed

    // 2. Fetch driving metadata and geometries from OSRM
    await calculateRouteGeometryAndStats();
    
    showSwedishModal("Rutt optimerad", `Rutten har optimerats!<br>Körordningen har beräknats för att minimera restid och sträcka, med hänsyn till dina fasta leveranspunkter.`);
    renderAll();
    if (mapPlanera) updatePlaneraMapPathsAndMarkers();
    if (map) updateMapPathsAndMarkers();
  } catch (e) {
    console.error(e);
    showSwedishModal("Ruttoptimering klar", "Rutten sorterades med lokala distanser. Vissa nätverkskartor kan dröja.");
    renderAll();
    if (mapPlanera) updatePlaneraMapPathsAndMarkers();
    if (map) updateMapPathsAndMarkers();
  } finally {
    optimizeBtn.disabled = false;
    optimizeBtn.textContent = "Optimera Rutt (Snabbaste vägen)";
  }
}

// Generalized TSP solver that optimizes delivery points between two anchors (either warehouse or pinned stops)
function solveTSPWithOptionalPins(startAnchor, endAnchor, stopsToOptimize) {
  if (stopsToOptimize.length === 0) return [];
  
  let unvisited = [...stopsToOptimize];
  let current = startAnchor;
  let ordered = [];
  
  // Nearest Neighbor starting heuristic
  while (unvisited.length > 0) {
    let bestIdx = 0;
    let minDist = Infinity;
    
    for (let i = 0; i < unvisited.length; i++) {
      let d = haversineDistance(current.lat, current.lon, unvisited[i].lat, unvisited[i].lon);
      if (d < minDist) {
        minDist = d;
        bestIdx = i;
      }
    }
    
    current = unvisited[bestIdx];
    ordered.push(current);
    unvisited.splice(bestIdx, 1);
  }
  
  // Refine with 2-opt edge-swap optimizer
  let improved = true;
  let iterations = 0;
  const maxIterations = 200;
  
  // If lockWarehouse is false and no endStop is pinned, we don't have a fixed endAnchor.
  // We check state.lockWarehouse or if endAnchor is the warehouse and lockWarehouse is false.
  const hasFixedEnd = (endAnchor !== state.warehouse) || state.lockWarehouse;
  const actualEnd = hasFixedEnd ? endAnchor : null;
  
  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;
    
    for (let i = 0; i < ordered.length - 1; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        let distCurrent = 0;
        let distNew = 0;
        
        // Construct full path segment for evaluation
        const fullList = [startAnchor, ...ordered];
        if (actualEnd) fullList.push(actualEnd);
        
        // i in ordered maps to i+1 in fullList.
        // j in ordered maps to j+1 in fullList.
        const p1 = fullList[i];
        const p2 = fullList[i + 1];
        const p3 = fullList[j + 1];
        const p4 = fullList[j + 2]; // endAnchor if j is at the end, or next node, or undefined
        
        if (!p2 || !p3) continue;
        
        distCurrent += haversineDistance(p1.lat, p1.lon, p2.lat, p2.lon);
        if (p4) {
          distCurrent += haversineDistance(p3.lat, p3.lon, p4.lat, p4.lon);
        }
        
        distNew += haversineDistance(p1.lat, p1.lon, p3.lat, p3.lon);
        if (p4) {
          distNew += haversineDistance(p2.lat, p2.lon, p4.lat, p4.lon);
        }
        
        if (distNew < distCurrent - 0.001) {
          reverseSegment(ordered, i, j);
          improved = true;
        }
      }
    }
  }
  
  return ordered;
}

// 2-Opt Segment Swapping Helper
function reverseSegment(array, i, j) {
  let left = i;
  let right = j;
  while (left < right) {
    let temp = array[left];
    array[left] = array[right];
    array[right] = temp;
    left++;
    right--;
  }
}

// Queries OSRM road API to fetch driving geometries, distances and durations
async function calculateRouteGeometryAndStats() {
  if (!state.warehouse || state.stops.length === 0) return null;

  // Build coordinate chain (lon,lat)
  let coordinates = [];
  coordinates.push(`${state.warehouse.lon},${state.warehouse.lat}`);
  
  state.stops.forEach(s => {
    coordinates.push(`${s.lon},${s.lat}`);
  });

  if (state.lockWarehouse) {
    coordinates.push(`${state.warehouse.lon},${state.warehouse.lat}`);
  }

  const coordStr = coordinates.join(";");
  const url = `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson`;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("OSRM API error");
    const data = await response.json();
    
    if (data.code === "Ok" && data.routes && data.routes.length > 0) {
      const mainRoute = data.routes[0];
      
      // Store road metrics globally on state
      state.roadDistance = mainRoute.distance / 1000; // to km
      state.roadDuration = mainRoute.duration / 60;   // to mins
      state.roadGeometry = mainRoute.geometry;        // geojson line coordinates
      
      // Distribute OSRM leg durations to stop structures
      if (mainRoute.legs && mainRoute.legs.length > 0) {
        for (let i = 0; i < state.stops.length; i++) {
          state.stops[i].duration = mainRoute.legs[i].duration / 60; // transit time to stop
        }
      }
      return true;
    }
  } catch (err) {
    console.warn("OSRM error, falling back to Euclidean heuristics:", err);
    
    // OFFLINE FALLBACK ENGINE
    let totalDist = 0;
    let current = state.warehouse;
    
    for (let i = 0; i < state.stops.length; i++) {
      let d = haversineDistance(current.lat, current.lon, state.stops[i].lat, state.stops[i].lon) * 1.3; // circuity
      state.stops[i].duration = (d / 50) * 60; // 50km/h average Sweden city speed
      totalDist += d;
      current = state.stops[i];
    }

    if (state.lockWarehouse) {
      totalDist += haversineDistance(current.lat, current.lon, state.warehouse.lat, state.warehouse.lon) * 1.3;
    }

    state.roadDistance = totalDist;
    state.roadDuration = (totalDist / 50) * 60;
    state.roadGeometry = null; // trigger straight lines
    return false;
  }
}

// ==========================================================================
// 6. DYNAMIC RENDER ENGINE: PLANERA TABS
// ==========================================================================
function renderPlaneraView() {
  const container = document.getElementById("stops-list-container");
  const placeholder = document.getElementById("empty-stops-placeholder");
  const statsLabel = document.getElementById("route-stats-label");
  const countLabel = document.getElementById("stops-count");

  container.innerHTML = "";
  countLabel.textContent = state.stops.length;

  if (state.stops.length === 0) {
    placeholder.classList.remove("hidden");
    statsLabel.textContent = "0 km | 0 min";
    return;
  }

  placeholder.classList.add("hidden");

  // Render Stop Cards
  state.stops.forEach((stop, index) => {
    const li = document.createElement("li");
    li.className = "stop-item";
    li.setAttribute("draggable", "true");
    li.setAttribute("data-id", stop.id);
    li.setAttribute("data-index", index);

    // Color code and labels for delivery progress
    let badgeText = index + 1;
    let statusHTML = "";
    if (stop.status === "completed") {
      statusHTML = `<span class="icon-emerald" style="font-size: 0.72rem; font-weight:700;">✓ Levererad</span>`;
    } else if (stop.status === "failed") {
      statusHTML = `<span class="icon-crimson" style="font-size: 0.72rem; font-weight:700;">⚠ Misslyckad</span>`;
    }

    const isStart = state.pinnedStartStopId === stop.id;
    const isEnd = state.pinnedEndStopId === stop.id;

    li.innerHTML = `
      <div class="drag-handle" title="Dra för att omorganisera">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18">
          <circle cx="9" cy="5" r="1.5"></circle><circle cx="9" cy="12" r="1.5"></circle><circle cx="9" cy="19" r="1.5"></circle>
          <circle cx="15" cy="5" r="1.5"></circle><circle cx="15" cy="12" r="1.5"></circle><circle cx="15" cy="19" r="1.5"></circle>
        </svg>
      </div>
      <div class="stop-badge">${badgeText}</div>
      <div class="stop-info">
        <span class="stop-address">${stop.address}</span>
        <div class="stop-details">
          <span>Stopptid: ${state.stopTime} min</span>
          ${statusHTML}
        </div>
      </div>
      <div class="stop-pin-actions">
        <button class="btn-pin-tag ${isStart ? 'active-start' : ''}" onclick="togglePinStart('${stop.id}')" title="Fäst som startleverans">
          ${isStart ? '★ Start' : 'Start'}
        </button>
        <button class="btn-pin-tag ${isEnd ? 'active-end' : ''}" onclick="togglePinEnd('${stop.id}')" title="Fäst som slutleverans">
          ${isEnd ? '★ Slut' : 'Slut'}
        </button>
      </div>
      <button class="stop-delete-btn" onclick="removeStop('${stop.id}')" aria-label="Ta bort stop">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
    `;
    container.appendChild(li);
  });

  // Attach Drag-and-drop actions
  addDragAndDropHandlers();

  // Print summary Stats
  if (state.roadDistance && state.roadDuration) {
    const totalDuration = Math.round(state.roadDuration + (state.stops.length * state.stopTime));
    statsLabel.textContent = `${state.roadDistance.toFixed(1)} km | ca ${totalDuration} min`;
  } else {
    statsLabel.textContent = "Optimera rutt för körtid";
  }
}

// Removes a specific stop
window.removeStop = function(id) {
  state.stops = state.stops.filter(s => s.id !== id);
  if (state.currentStopIndex >= state.stops.length) {
    state.currentStopIndex = Math.max(0, state.stops.length - 1);
  }
  // Clear dangling pin references
  if (state.pinnedStartStopId === id) state.pinnedStartStopId = null;
  if (state.pinnedEndStopId === id) state.pinnedEndStopId = null;

  // Recompute road geometries since matrix altered
  calculateRouteGeometryAndStats().then(() => {
    renderAll();
    if (mapPlanera) updatePlaneraMapPathsAndMarkers();
    if (map) updateMapPathsAndMarkers();
  });
};

window.togglePinStart = function(id) {
  if (state.pinnedStartStopId === id) {
    state.pinnedStartStopId = null;
  } else {
    state.pinnedStartStopId = id;
    if (state.pinnedEndStopId === id) {
      state.pinnedEndStopId = null;
    }
  }
  renderAll();
  if (mapPlanera) updatePlaneraMapPathsAndMarkers();
};

window.togglePinEnd = function(id) {
  if (state.pinnedEndStopId === id) {
    state.pinnedEndStopId = null;
  } else {
    state.pinnedEndStopId = id;
    if (state.pinnedStartStopId === id) {
      state.pinnedStartStopId = null;
    }
  }
  renderAll();
  if (mapPlanera) updatePlaneraMapPathsAndMarkers();
};

// ==========================================================================
// 7. DRAG AND DROP HANDLERS (TACTILE LIST REORDER)
// ==========================================================================
function initDragAndDrop() {
  // Empty constructor placeholder, handled dynamically
}

function addDragAndDropHandlers() {
  const items = document.querySelectorAll(".stops-list .stop-item");
  items.forEach(item => {
    item.addEventListener("dragstart", handleDragStart, false);
    item.addEventListener("dragover", handleDragOver, false);
    item.addEventListener("drop", handleDrop, false);
    item.addEventListener("dragend", handleDragEnd, false);
    
    // Add touch triggers for mobile screens
    item.addEventListener("touchstart", handleTouchStart, {passive: true});
    item.addEventListener("touchmove", handleTouchMove, {passive: false});
    item.addEventListener("touchend", handleTouchEnd, false);
  });
}

// Desktop HTML5 drag handles
function handleDragStart(e) {
  this.classList.add("dragging");
  dragSrcEl = this;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/html", this.innerHTML);
}

function handleDragOver(e) {
  if (e.preventDefault) {
    e.preventDefault();
  }
  e.dataTransfer.dropEffect = "move";
  return false;
}

function handleDrop(e) {
  if (e.stopPropagation) {
    e.stopPropagation();
  }
  
  if (dragSrcEl !== this) {
    const srcIndex = parseInt(dragSrcEl.getAttribute("data-index"));
    const targetIndex = parseInt(this.getAttribute("data-index"));
    
    // Shift state index sequence
    const movedItem = state.stops.splice(srcIndex, 1)[0];
    state.stops.splice(targetIndex, 0, movedItem);
    
    // Refresh calculations and render
    calculateRouteGeometryAndStats().then(() => {
      renderAll();
      if (mapPlanera) updatePlaneraMapPathsAndMarkers();
      if (map) updateMapPathsAndMarkers();
    });
  }
  return false;
}

function handleDragEnd(e) {
  this.classList.remove("dragging");
  const items = document.querySelectorAll(".stops-list .stop-item");
  items.forEach(item => item.classList.remove("dragging"));
}

// Touch controls for mobile phones drag mapping
let touchStartY = 0;
let touchElement = null;

function handleTouchStart(e) {
  touchStartY = e.touches[0].clientY;
  touchElement = this;
}

function handleTouchMove(e) {
  if (!touchElement) return;
  const currentY = e.touches[0].clientY;
  const deltaY = currentY - touchStartY;
  
  // Custom threshold swipe or drag implementation could go here.
  // Standard drag handles are optimal, on iOS deep press allows dragging.
}

function handleTouchEnd(e) {
  touchElement = null;
}

// ==========================================================================
// 8. DYNAMIC RENDER ENGINE: LASTLISTA (LIFO WAREHOUSE PACKING)
// ==========================================================================
function renderLastlistaView() {
  const container = document.getElementById("cargo-list-container");
  const placeholder = document.getElementById("empty-cargo-placeholder");
  const indicators = document.getElementById("packing-zones-indicator");
  const progressText = document.getElementById("cargo-progress-text");
  const progressBar = document.getElementById("cargo-progress-bar");

  container.innerHTML = "";

  if (state.stops.length === 0) {
    placeholder.classList.remove("hidden");
    indicators.classList.add("hidden");
    progressText.textContent = "0 / 0 (0%)";
    progressBar.style.width = "0%";
    return;
  }

  placeholder.classList.add("hidden");
  indicators.classList.remove("hidden");

  // Create cargo list - IN REVERSE ORDER OF ROUTE (LIFO)
  // First delivery (index 0) must be loaded LAST (top of the list)
  const lifoStops = [...state.stops].reverse();
  
  let loadedCount = 0;
  lifoStops.forEach((stop, index) => {
    // True stop sequence index
    const stopOriginalIndex = state.stops.findIndex(s => s.id === stop.id);
    const stopNumber = stopOriginalIndex + 1;
    
    if (stop.cargoLoaded) {
      loadedCount++;
    }

    const li = document.createElement("li");
    li.className = `cargo-item ${stop.cargoLoaded ? "loaded" : ""}`;
    
    li.innerHTML = `
      <div class="cargo-left">
        <div class="cargo-package-badge">${stopNumber}</div>
        <div class="cargo-info">
          <span class="cargo-address">${stop.address}</span>
          <span class="cargo-sequence-text">Levereras som stopp #${stopNumber}</span>
        </div>
      </div>
      <div class="cargo-checkbox-container" onclick="toggleCargoLoaded('${stop.id}')" aria-label="Markera som inlastad">
        <div class="cargo-checkbox">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </div>
      </div>
    `;
    container.appendChild(li);
  });

  // Calculate cargo completeness percentage
  const total = state.stops.length;
  const percent = total > 0 ? Math.round((loadedCount / total) * 100) : 0;
  progressText.textContent = `${loadedCount} / ${total} (${percent}%)`;
  progressBar.style.width = `${percent}%`;
}

window.toggleCargoLoaded = function(stopId) {
  const stop = state.stops.find(s => s.id === stopId);
  if (stop) {
    stop.cargoLoaded = !stop.cargoLoaded;
    renderAll();
  }
};

// ==========================================================================
// 9. DYNAMIC RENDER ENGINE: KÖRLÄGE & PROGRESS MAP
// ==========================================================================
function renderKorlageView() {
  const container = document.getElementById("active-stop-card-container");
  const carousel = document.getElementById("upcoming-stops-carousel");
  const counter = document.getElementById("drive-progress-counter");
  const percentLabel = document.getElementById("drive-progress-percent");
  const bar = document.getElementById("drive-progress-bar");

  container.innerHTML = "";
  carousel.innerHTML = "";

  if (state.stops.length === 0) {
    container.innerHTML = `
      <div class="active-stop-card warehouse-stop">
        <div class="card-badge-row">
          <span class="active-badge orange">Information</span>
        </div>
        <div class="active-address-block">
          <span class="active-address">Ingen rutt skapad</span>
          <p class="active-meta" style="margin-top: 10px;">Skapa en leveransrutt under fliken "Planera" först för att påbörja din körning.</p>
        </div>
      </div>
    `;
    counter.textContent = "0 / 0 Levererade";
    percentLabel.textContent = "0% Färdigt";
    bar.style.width = "0%";
    
    // Update dashboard side stats to zero
    document.getElementById("drive-remaining-time").textContent = "--:--";
    document.getElementById("drive-remaining-distance").textContent = "0 km";
    return;
  }

  // Calculate delivery stats
  const totalStops = state.stops.length;
  const completedStops = state.stops.filter(s => s.status === "completed").length;
  const deliveryPercent = Math.round((completedStops / totalStops) * 100);
  
  counter.textContent = `${completedStops} / ${totalStops} Levererade`;
  percentLabel.textContent = `${deliveryPercent}% Färdigt`;
  bar.style.width = `${deliveryPercent}%`;

  // Find current active stop. The active stop is the first stop with status "pending"
  let activeIndex = state.stops.findIndex(s => s.status === "pending");
  let activeStop = null;
  let isReturningToWarehouse = false;

  if (activeIndex !== -1) {
    state.currentStopIndex = activeIndex;
    activeStop = state.stops[activeIndex];
  } else {
    // All stops processed -> Return to Warehouse state
    isReturningToWarehouse = true;
    state.currentStopIndex = totalStops; // virtual warehouse return index
  }

  // Render the large tactile Active Stop Card
  if (isReturningToWarehouse) {
    // return to warehouse template
    container.innerHTML = `
      <div class="active-stop-card warehouse-stop">
        <div class="card-badge-row">
          <span class="active-badge orange">Lagerretur</span>
          <span class="active-eta-clock" id="active-stop-eta">ETA: Beräknar...</span>
        </div>
        <div class="active-address-block">
          <span class="active-address">${state.warehouse ? state.warehouse.address : "Kör tillbaka till lagret"}</span>
          <div class="active-meta">
            <span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              Warehouse Return
            </span>
          </div>
        </div>
        ${state.warehouse ? `
          <button class="btn-nav-launch" onclick="launchGoogleMaps('${encodeURIComponent(state.warehouse.address)}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
            Starta navigering
          </button>
        ` : ""}
      </div>
    `;
  } else {
    // delivery stop template
    const stopNumber = activeIndex + 1;
    container.innerHTML = `
      <div class="active-stop-card delivery-stop">
        <div class="card-badge-row">
          <span class="active-badge blue">Stopp #${stopNumber}</span>
          <span class="active-eta-clock" id="active-stop-eta">ETA: Beräknar...</span>
        </div>
        <div class="active-address-block">
          <span class="active-address">${activeStop.address}</span>
          <div class="active-meta">
            <span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="1" y="3" width="15" height="13" rx="2" ry="2"/><line x1="16" y1="8" x2="20" y2="8"/><line x1="16" y1="12" x2="23" y2="12"/><line x1="1" y1="8" x2="16" y2="8"/><line x1="12" y1="3" x2="12" y2="16"/></svg>
              Paket #${stopNumber}
            </span>
          </div>
        </div>
        
        <button class="btn-nav-launch" onclick="launchGoogleMaps('${encodeURIComponent(activeStop.address)}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
          Starta navigering
        </button>

        <div class="driver-action-grid">
          <button class="btn-failed-delivery" onclick="markActiveStopFailed()">
            Kunde ej leverera
          </button>
          <button class="btn-success" onclick="markActiveStopDelivered()">
            Levererad
          </button>
        </div>
      </div>
    `;
  }

  // Render Horizontal Stop Carousel Scroller
  state.stops.forEach((stop, index) => {
    let statusClass = "pending";
    let statusText = "Väntar";
    if (stop.status === "completed") {
      statusClass = "completed";
      statusText = "Levererad";
    } else if (stop.status === "failed") {
      statusClass = "failed";
      statusText = "Misslyckad";
    } else if (index === activeIndex) {
      statusClass = "active";
      statusText = "Aktiv";
    }

    const card = document.createElement("div");
    card.className = `carousel-card ${statusClass}`;
    card.onclick = () => focusCarouselStop(index);

    card.innerHTML = `
      <div class="carousel-header">
        <span class="carousel-num">${index + 1}</span>
        <span class="carousel-status-tag status-tag-${statusClass}">${statusText}</span>
      </div>
      <span class="carousel-address">${stop.address}</span>
      <span class="carousel-eta" id="carousel-eta-${index}">--:--</span>
    `;
    carousel.appendChild(card);
  });
}

// Deep links standard destination address to native Google Maps navigation
window.launchGoogleMaps = function(address) {
  const decoded = decodeURIComponent(address);
  const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(decoded)}&travelmode=driving`;
  window.open(url, "_blank");
};

// Driver marks active delivery successful
window.markActiveStopDelivered = function() {
  const activeIndex = state.stops.findIndex(s => s.status === "pending");
  if (activeIndex !== -1) {
    state.stops[activeIndex].status = "completed";
    
    // Automatically advance active window focus
    renderAll();
    
    // Recenter and re-plot map focus
    if (mapPlanera) updatePlaneraMapPathsAndMarkers();
    if (map) updateMapPathsAndMarkers();
  }
};

// Driver marks active delivery failed
// Moves current address to absolute end of queue directly before final return
window.markActiveStopFailed = function() {
  const activeIndex = state.stops.findIndex(s => s.status === "pending");
  if (activeIndex !== -1) {
    const failedStop = state.stops[activeIndex];
    failedStop.status = "failed";
    
    showSwedishModal(
      "Leverans misslyckades", 
      `Leveransen flyttades till slutet av kön (precis innan återresa till lagret) för ett nytt leveransförsök senare.`
    );
    
    // Re-route logistics array sequencing
    state.stops.splice(activeIndex, 1); // remove from current index position
    
    // Clone stop with reset status to try again later at the end of routing queue
    const retryStop = {
      ...failedStop,
      status: "pending" // reset back to try again at final loop
    };
    state.stops.push(retryStop);

    // Recompute road itineraries
    calculateRouteGeometryAndStats().then(() => {
      renderAll();
      if (mapPlanera) updatePlaneraMapPathsAndMarkers();
      if (map) updateMapPathsAndMarkers();
    });
  }
};

// Lets driver click cards in carousel scroller to inspect them
window.focusCarouselStop = function(index) {
  const stop = state.stops[index];
  if (stop && map) {
    map.setView([stop.lat, stop.lon], 15);
    // Open marker popup automatically
    markersGroup.eachLayer(layer => {
      if (layer.options.title === stop.address) {
        layer.openPopup();
      }
    });
  }
};

// ==========================================================================
// 10. LEAFLET INTERACTIVE ROAD MAP SETUP
// ==========================================================================

// --- PLANERA VIEW MAP ---
function initPlaneraMap() {
  if (mapPlanera !== null) {
    mapPlanera.invalidateSize();
    return;
  }

  const container = document.getElementById("leaflet-planera-map");
  if (!container) return;

  let centerLat = 56.6744; 
  let centerLon = 12.8578;

  if (state.warehouse) {
    centerLat = state.warehouse.lat;
    centerLon = state.warehouse.lon;
  } else if (state.stops.length > 0) {
    centerLat = state.stops[0].lat;
    centerLon = state.stops[0].lon;
  }

  mapPlanera = L.map("leaflet-planera-map", {
    zoomControl: true,
    tap: false
  }).setView([centerLat, centerLon], 12);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(mapPlanera);

  planeraMarkersGroup = L.featureGroup().addTo(mapPlanera);
  
  updatePlaneraMapPathsAndMarkers();
}

function updatePlaneraMapPathsAndMarkers() {
  if (!mapPlanera || !planeraMarkersGroup) return;

  planeraMarkersGroup.clearLayers();
  if (planeraRouteLine) mapPlanera.removeLayer(planeraRouteLine);

  let bounds = [];

  // 1. Draw Warehouse Marker
  if (state.warehouse) {
    const warehouseIcon = L.divIcon({
      className: "custom-leaflet-marker orange",
      html: `<div class="marker-pin orange"></div><div class="marker-num" style="font-size: 1rem; top: -1px;">🏠</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 30]
    });
    
    const warehouseMarker = L.marker([state.warehouse.lat, state.warehouse.lon], {
      icon: warehouseIcon,
      title: state.warehouse.address
    }).bindPopup(`
      <div style="font-family: var(--font-primary); font-size: 0.85rem; color: #fff;">
        <strong style="color:var(--accent-orange);">Start-/Slutlager</strong><br>
        <span style="color:var(--text-muted);">${state.warehouse.address}</span><br>
        <button class="btn-primary" style="height:32px; padding:0 12px; font-size:0.8rem; margin-top:8px; width:100%; font-weight:700; border-radius:4px; display:inline-flex; align-items:center; justify-content:center; color:#fff;" onclick="launchGoogleMaps('${encodeURIComponent(state.warehouse.address)}')">
          Starta navigering
        </button>
      </div>
    `);
    
    planeraMarkersGroup.addLayer(warehouseMarker);
    bounds.push([state.warehouse.lat, state.warehouse.lon]);
  }

  // 2. Draw Stop Markers (1 to N)
  state.stops.forEach((stop, index) => {
    let pinColor = "blue";
    
    const isStart = state.pinnedStartStopId === stop.id;
    const isEnd = state.pinnedEndStopId === stop.id;

    if (stop.status === "completed") {
      pinColor = "emerald";
    } else if (stop.status === "failed") {
      pinColor = "crimson";
    } else if (isStart) {
      pinColor = "emerald";
    } else if (isEnd) {
      pinColor = "orange";
    }

    const stopIcon = L.divIcon({
      className: `custom-leaflet-marker ${pinColor}`,
      html: `<div class="marker-pin ${pinColor}"></div><div class="marker-num">${index + 1}</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 32]
    });

    const popupContent = `
      <div style="font-family: var(--font-primary); font-size: 0.85rem; color: #fff;">
        <strong style="color:var(--accent-blue);">Stopp #${index + 1} ${isStart ? '★ START' : ''} ${isEnd ? '★ SLUT' : ''}</strong><br>
        <span style="color:var(--text-muted);">${stop.address}</span><br>
        <button class="btn-primary" style="height:32px; padding:0 12px; font-size:0.8rem; margin-top:8px; width:100%; font-weight:700; border-radius:4px; display:inline-flex; align-items:center; justify-content:center; color:#fff;" onclick="launchGoogleMaps('${encodeURIComponent(stop.address)}')">
          Starta navigering
        </button>
      </div>
    `;

    const marker = L.marker([stop.lat, stop.lon], {
      icon: stopIcon,
      title: stop.address
    }).bindPopup(popupContent);

    planeraMarkersGroup.addLayer(marker);
    bounds.push([stop.lat, stop.lon]);
  });

  // 3. Draw Road Routing Polyline path
  let pathCoords = [];
  if (state.roadGeometry) {
    pathCoords = state.roadGeometry.coordinates.map(c => [c[1], c[0]]);
  } else {
    if (state.warehouse) pathCoords.push([state.warehouse.lat, state.warehouse.lon]);
    state.stops.forEach(s => pathCoords.push([s.lat, s.lon]));
    if (state.lockWarehouse && state.warehouse) pathCoords.push([state.warehouse.lat, state.warehouse.lon]);
  }

  if (pathCoords.length > 1) {
    planeraRouteLine = L.polyline(pathCoords, {
      color: "var(--accent-blue)",
      weight: 5,
      opacity: 0.8,
      lineJoin: "round"
    }).addTo(mapPlanera);
  }

  if (bounds.length > 0) {
    mapPlanera.fitBounds(bounds, { padding: [40, 40] });
  }
}


// --- KÖRLÄGE VIEW MAP ---
function initLeafletMap() {
  if (map !== null) {
    map.invalidateSize();
    return;
  }

  let centerLat = 56.6744; 
  let centerLon = 12.8578;

  if (state.warehouse) {
    centerLat = state.warehouse.lat;
    centerLon = state.warehouse.lon;
  } else if (state.stops.length > 0) {
    centerLat = state.stops[0].lat;
    centerLon = state.stops[0].lon;
  }

  map = L.map("leaflet-route-map", {
    zoomControl: true,
    tap: false
  }).setView([centerLat, centerLon], 12);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);

  markersGroup = L.featureGroup().addTo(map);
  
  updateMapPathsAndMarkers();
}

function updateMapPathsAndMarkers() {
  if (!map || !markersGroup) return;

  markersGroup.clearLayers();
  if (routeLine) map.removeLayer(routeLine);

  let bounds = [];

  // 1. Draw Warehouse Marker
  if (state.warehouse) {
    const warehouseIcon = L.divIcon({
      className: "custom-leaflet-marker orange",
      html: `<div class="marker-pin orange">🏠</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 30]
    });
    
    const warehouseMarker = L.marker([state.warehouse.lat, state.warehouse.lon], {
      icon: warehouseIcon,
      title: state.warehouse.address
    }).bindPopup(`
      <div style="font-family: var(--font-primary); font-size: 0.85rem; color: #fff;">
        <strong style="color:var(--accent-orange);">Start-/Slutlager</strong><br>
        <span style="color:var(--text-muted);">${state.warehouse.address}</span><br>
        <button class="btn-primary" style="height:32px; padding:0 12px; font-size:0.8rem; margin-top:8px; width:100%; font-weight:700; border-radius:4px; display:inline-flex; align-items:center; justify-content:center; color:#fff;" onclick="launchGoogleMaps('${encodeURIComponent(state.warehouse.address)}')">
          Starta navigering
        </button>
      </div>
    `);
    
    markersGroup.addLayer(warehouseMarker);
    bounds.push([state.warehouse.lat, state.warehouse.lon]);
  }

  // 2. Draw Stop Markers
  state.stops.forEach((stop, index) => {
    let pinColor = "blue";

    if (stop.status === "completed") {
      pinColor = "emerald";
    } else if (stop.status === "failed") {
      pinColor = "crimson";
    } else if (index === state.currentStopIndex) {
      pinColor = "glow";
    }

    const stopIcon = L.divIcon({
      className: `custom-leaflet-marker ${pinColor}`,
      html: `<div class="marker-pin ${pinColor}"></div><div class="marker-num">${index + 1}</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 32]
    });

    const popupContent = `
      <div style="font-family: var(--font-primary); font-size: 0.85rem; color: #fff;">
        <strong style="color:var(--accent-blue);">Stopp #${index + 1}</strong><br>
        <span style="color:var(--text-muted);">${stop.address}</span><br>
        <span style="font-size:0.75rem; color:var(--text-muted);">Status: ${stop.status === "pending" ? "Väntar" : (stop.status === "completed" ? "Levererad" : "Misslyckad")}</span><br>
        <button class="btn-primary" style="height:32px; padding:0 12px; font-size:0.8rem; margin-top:8px; width:100%; font-weight:700; border-radius:4px; display:inline-flex; align-items:center; justify-content:center; color:#fff;" onclick="launchGoogleMaps('${encodeURIComponent(stop.address)}')">
          Starta navigering
        </button>
      </div>
    `;

    const marker = L.marker([stop.lat, stop.lon], {
      icon: stopIcon,
      title: stop.address
    }).bindPopup(popupContent);

    markersGroup.addLayer(marker);
    bounds.push([stop.lat, stop.lon]);
  });

  // 3. Draw Road Routing Polyline path
  let pathCoords = [];
  if (state.roadGeometry) {
    pathCoords = state.roadGeometry.coordinates.map(c => [c[1], c[0]]);
  } else {
    if (state.warehouse) pathCoords.push([state.warehouse.lat, state.warehouse.lon]);
    state.stops.forEach(s => pathCoords.push([s.lat, s.lon]));
    if (state.lockWarehouse && state.warehouse) pathCoords.push([state.warehouse.lat, state.warehouse.lon]);
  }

  if (pathCoords.length > 1) {
    routeLine = L.polyline(pathCoords, {
      color: "var(--accent-blue)",
      weight: 5,
      opacity: 0.8,
      lineJoin: "round"
    }).addTo(map);
  }

  if (bounds.length > 0) {
    map.fitBounds(bounds, { padding: [40, 40] });
  }
}

// ==========================================================================
// 11. STATIC ETA & TIME ENGINE
// ==========================================================================
function updateGlobalETAEngine() {
  const headerBadge = document.getElementById("header-eta-badge");
  const activeStopEtaLabel = document.getElementById("active-stop-eta");
  const driveRemainingTime = document.getElementById("drive-remaining-time");
  const driveRemainingDistance = document.getElementById("drive-remaining-distance");

  if (state.stops.length === 0) {
    headerBadge.textContent = "Ber. Sluttid: --:--";
    headerBadge.classList.remove("complete");
    return;
  }

  const now = new Date();
  
  // Calculate remaining stats
  let totalRemainingTransit = 0;
  let remainingStopsCount = 0;
  
  // Array of accumulative ETAs for stops
  let cumulativeTime = new Date(now.getTime());

  // Loop through stops starting from current active driver index position
  for (let i = 0; i < state.stops.length; i++) {
    const stop = state.stops[i];
    const carouselEtaLabel = document.getElementById(`carousel-eta-${i}`);
    
    if (stop.status === "completed") {
      // Completed -> Crossed out card and shows delivered status
      if (carouselEtaLabel) carouselEtaLabel.textContent = "Levererad";
      continue;
    }

    remainingStopsCount++;
    
    // Add leg driving transit duration (convert minutes to ms)
    totalRemainingTransit += stop.duration;
    cumulativeTime.setTime(cumulativeTime.getTime() + (stop.duration * 60 * 1000));
    
    // Render dynamic carousel clock label
    const timeStr = formatClockTime(cumulativeTime);
    if (carouselEtaLabel) carouselEtaLabel.textContent = `ETA: ${timeStr}`;

    // Active stop ETA label tracking
    if (i === state.currentStopIndex) {
      if (activeStopEtaLabel) activeStopEtaLabel.textContent = `Ankomst ca: ${timeStr}`;
    }

    // Add Stop handling processing delay
    cumulativeTime.setTime(cumulativeTime.getTime() + (state.stopTime * 60 * 1000));
  }

  // Add final warehouse return leg driving time
  let returnLegDuration = 0;
  if (state.lockWarehouse && state.warehouse && state.stops.length > 0) {
    const lastStop = state.stops[state.stops.length - 1];
    const d = haversineDistance(lastStop.lat, lastStop.lon, state.warehouse.lat, state.warehouse.lon) * 1.3;
    returnLegDuration = (d / 50) * 60; // fallback in minutes
    
    totalRemainingTransit += returnLegDuration;
    cumulativeTime.setTime(cumulativeTime.getTime() + (returnLegDuration * 60 * 1000));
  }

  // Render return sluttid (the absolute clock time driver returns)
  const returnTimeStr = formatClockTime(cumulativeTime);
  headerBadge.textContent = `Retur Lager: ${returnTimeStr}`;
  
  if (remainingStopsCount === 0) {
    headerBadge.classList.add("complete");
    headerBadge.textContent = "Passet Avslutat ✓";
    if (activeStopEtaLabel) activeStopEtaLabel.textContent = "Klar för dagen!";
  } else {
    headerBadge.classList.remove("complete");
  }

  // Update driving tab side stats
  const totalRemainingMinutes = Math.round(totalRemainingTransit + (remainingStopsCount * state.stopTime));
  if (driveRemainingTime) {
    driveRemainingTime.textContent = `${totalRemainingMinutes} min`;
  }
  if (driveRemainingDistance && state.roadDistance) {
    // Show rough remaining distance estimation
    const progressFactor = remainingStopsCount / state.stops.length;
    driveRemainingDistance.textContent = `${(state.roadDistance * progressFactor).toFixed(1)} km`;
  }
}

function formatClockTime(date) {
  const hrs = String(date.getHours()).padStart(2, "0");
  const mins = String(date.getMinutes()).padStart(2, "0");
  return `${hrs}:${mins}`;
}

// ==========================================================================
// 12. CUSTOM POPUP SYSTEM (PREMIUM DESIGN ALERTS)
// ==========================================================================
let modalCallback = null;

function initModals() {
  const backdrop = document.getElementById("custom-modal");
  const closeX = document.getElementById("modal-close-x");
  const okBtn = document.getElementById("modal-ok-btn");

  const closeModal = () => {
    backdrop.classList.add("hidden");
    modalCallback = null;
  };

  closeX.addEventListener("click", closeModal);
  okBtn.addEventListener("click", () => {
    if (modalCallback) modalCallback();
    closeModal();
  });
  
  // Close modal when tapping background backdrop
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeModal();
  });
}

function showSwedishModal(title, text) {
  const backdrop = document.getElementById("custom-modal");
  const titleEl = document.getElementById("modal-title");
  const messageEl = document.getElementById("modal-message");
  const actions = document.getElementById("modal-actions-container");

  titleEl.textContent = title;
  messageEl.innerHTML = text; // support html markup for bold text
  
  // Single OK button template
  actions.innerHTML = `<button class="btn-primary" id="modal-ok-btn" style="width:100%;">OK</button>`;
  
  // Bind close event directly
  document.getElementById("modal-ok-btn").addEventListener("click", () => {
    backdrop.classList.add("hidden");
  });

  backdrop.classList.remove("hidden");
}

function showSwedishConfirmModal(title, text, confirmCallback) {
  const backdrop = document.getElementById("custom-modal");
  const titleEl = document.getElementById("modal-title");
  const messageEl = document.getElementById("modal-message");
  const actions = document.getElementById("modal-actions-container");

  titleEl.textContent = title;
  messageEl.innerHTML = text;
  
  // Double button template
  actions.innerHTML = `
    <button class="btn-secondary" id="modal-cancel-btn">Avbryt</button>
    <button class="btn-primary" id="modal-confirm-btn" style="background-color: var(--accent-crimson);">Rensa</button>
  `;
  
  document.getElementById("modal-cancel-btn").addEventListener("click", () => {
    backdrop.classList.add("hidden");
  });

  document.getElementById("modal-confirm-btn").addEventListener("click", () => {
    confirmCallback();
    backdrop.classList.add("hidden");
  });

  backdrop.classList.remove("hidden");
}
