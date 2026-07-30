// ── SETUP ──────────────────────────────────────────────────────────
mapboxgl.accessToken = 'pk.eyJ1IjoibWFyay10ZWUiLCJhIjoiY21zN2l3cHk2MDRjazM5cGxpc2hnbmY1cSJ9.VdHqEZXBn5LJ4QvFkUAtXw'; // ⚠️ MANUAL INPUT NEEDED: your real Mapbox token

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/standard',
  center: [3.82550, 7.24072], // ⚠️ MANUAL INPUT NEEDED: your real campus coordinates (used only briefly, before the campus-wide view takes over)
  zoom: 16,
  pitch: 60,
  bearing: -20
});

let walkGraph = {};
let driveGraph = {};

let currentMode = 'walk';
let originCoord = null;
let destCoord = null;

const WALK_SPEED_MPS = 1.4;
const DRIVE_SPEED_MPS = 8.3;

let buildingList = [];

let userMarker = null;
let watchId = null;

// NEW: tracks whether the camera should keep re-centering on the user's
// live position. Turned on by "Start Navigation" / "Recenter", turned
// off automatically the moment the user manually drags or zooms.
let followMode = false;

let dataReady = {
  buildings: false,
  network: false
};


map.on('load', () => {

  map.addSource('campus-buildings', {
    type: 'geojson',
    data: 'data/data/data/Buildings.geojson'
  });

  map.addLayer({
    id: 'buildings-3d',
    type: 'fill-extrusion',
    source: 'campus-buildings',
    paint: {
      'fill-extrusion-color': '#8899aa',
      'fill-extrusion-height': ['get', 'Building_H'],
      'fill-extrusion-opacity': 0.9
    }
  });

  map.addSource('campus-paths', {
    type: 'geojson',
    data: 'data/data/data/Foot_path.geojson'
  });

  map.addLayer({
    id: 'paths-line',
    type: 'line',
    source: 'campus-paths',
    paint: {
      'line-color': '#9e9e9e',
      'line-width': 3
    }
  });

  map.addSource('campus-roads', {
    type: 'geojson',
    data: 'data/data/data/Roads.geojson'
  });

  map.addLayer({
    id: 'roads-line',
    type: 'line',
    source: 'campus-roads',
    paint: {
      'line-color': '#9e9e9e',
      'line-width': 4
    }
  });

  map.addSource('campus-landmarks', {
    type: 'geojson',
    data: 'data/data/data/LandMarks.geojson'
  });

  map.addLayer({
    id: 'landmarks-point',
    type: 'circle',
    source: 'campus-landmarks',
    paint: {
      'circle-radius': 6,
      'circle-color': '#9b59b6',
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff'
    }
  });

  map.addSource('route-line-source', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });

  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route-line-source',
    paint: {
      'line-color': '#1565c0',
      'line-width': 6,
      'line-opacity': 0.95
    }
  });

  map.on('click', 'landmarks-point', (e) => {
    const name = e.features[0].properties.Name || 'Unnamed landmark';
    new mapboxgl.Popup()
      .setLngLat(e.lngLat)
      .setHTML(`<strong>${name}</strong>`)
      .addTo(map);
  });

  map.on('mouseenter', 'landmarks-point', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'landmarks-point', () => {
    map.getCanvas().style.cursor = '';
  });

  fetch('data/data/data/Buildings.geojson')
    .then(res => {
      if (!res.ok) throw new Error(`Server responded with ${res.status}`);
      return res.json();
    })
    .then(data => {
      buildingList = extractNamedLocations(data);
      buildingList.sort((a, b) => a.name.localeCompare(b.name));

      // NEW: show the entire campus on first load, using the real
      // extent of the buildings data rather than a guessed zoom level.
      const campusBbox = turf.bbox(data);
      map.fitBounds(campusBbox, { padding: 40, pitch: 60, duration: 0 });

      dataReady.buildings = true;
      checkAllDataReady();
    })
    .catch(err => {
      console.error('Failed to load Buildings.geojson:', err);
      showLoadError('Could not load building data. Please refresh, or check your connection.');
    });

  fetch('data/data/data/CampusNetwork.geojson')
    .then(res => {
      if (!res.ok) throw new Error(`Server responded with ${res.status}`);
      return res.json();
    })
    .then(data => {
      walkGraph = buildGraph(data, 'walk');
      driveGraph = buildGraph(data, 'drive');

      console.log('Walk graph nodes:', Object.keys(walkGraph).length);
      console.log('Walk graph islands (should be 1):', countIslands(walkGraph));
      console.log('Drive graph nodes:', Object.keys(driveGraph).length);
      console.log('Drive graph islands (should be 1):', countIslands(driveGraph));

      dataReady.network = true;
      checkAllDataReady();
    })
    .catch(err => {
      console.error('Failed to load CampusNetwork.geojson:', err);
      showLoadError('Could not load routing data. Please refresh, or check your connection.');
    });

  // NEW: clicking a building now sets it as the DESTINATION directly
  // (origin comes from live GPS now, not from clicks), as a fallback
  // to typing in the search panel.
  map.on('click', 'buildings-3d', (e) => {
    if (!dataReady.buildings || !dataReady.network) return;
    destCoord = [e.lngLat.lng, e.lngLat.lat];
    document.getElementById('dest-input').value = 'Selected on map';
    document.getElementById('suggestions').innerHTML = '';
  });

  // NEW: request geolocation permission immediately on load, instead
  // of waiting for a button click.
  startLiveLocation();

  // NEW: detect genuine user-driven map interaction (as opposed to our
  // own programmatic camera moves) to pause follow mode.
  map.on('dragstart', () => { followMode = false; });
  map.on('zoomstart', (e) => {
    if (e.originalEvent) followMode = false; // only real user zoom gestures have this
  });

});


// ── LOADING STATE MANAGEMENT ─────────────────────────────────────────

function checkAllDataReady() {
  if (dataReady.buildings && dataReady.network) {
    document.getElementById('loading-overlay').classList.add('hidden');
    document.getElementById('dest-input').disabled = false;
    document.getElementById('search-btn').disabled = false;
    updateStatus('Search for a destination to begin.');
  }
}

function showLoadError(message) {
  document.getElementById('loading-box').innerHTML = `<p style="color:#c0392b;">${message}</p>`;
}


// ── LIVE LOCATION TRACKING ───────────────────────────────────────────

function startLiveLocation() {
  if (!navigator.geolocation) {
    updateStatus('Location is not supported on this browser.');
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      const liveCoord = [position.coords.longitude, position.coords.latitude];
      originCoord = liveCoord;

      if (!userMarker) {
        userMarker = new mapboxgl.Marker({ color: '#2a72d4' })
          .setLngLat(liveCoord)
          .addTo(map);
      } else {
        userMarker.setLngLat(liveCoord);
      }

      // If we're in follow mode (navigation actively started), keep
      // recentering the camera on the user WITHOUT changing zoom —
      // this is what lets a user-chosen zoom-out persist across updates.
      if (followMode) {
        map.easeTo({ center: liveCoord, duration: 800 });
      }
    },
    (error) => {
      updateStatus('Could not get your location. Check permissions and try again.');
      console.error('Geolocation error:', error);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}


// ── SEARCH PANEL: AUTOCOMPLETE + DESTINATION SELECTION ──────────────

function extractNamedLocations(geojson) {
  const results = [];

  geojson.features.forEach(feature => {
    const name = feature.properties.Name;
    if (!name) return;

    const centroid = turf.centroid(feature);
    const coord = centroid.geometry.coordinates;

    results.push({ name, coord });
  });

  return results;
}

const destInput = document.getElementById('dest-input');
const suggestionsBox = document.getElementById('suggestions');

destInput.addEventListener('input', () => {
  const query = destInput.value.trim().toLowerCase();
  suggestionsBox.innerHTML = '';

  if (query.length === 0) {
    destCoord = null; // clear any prior selection once the user starts typing fresh
    return;
  }

  // Show up to 6 matches whose name contains the typed text anywhere,
  // not just at the start — more forgiving for partial/misremembered names.
  const matches = buildingList.filter(b => b.name.toLowerCase().includes(query)).slice(0, 6);

  matches.forEach(match => {
    const item = document.createElement('div');
    item.className = 'suggestion-item';
    item.textContent = match.name;
    item.addEventListener('click', () => {
      destInput.value = match.name;
      destCoord = match.coord;
      suggestionsBox.innerHTML = ''; // close the suggestion list once picked
    });
    suggestionsBox.appendChild(item);
  });
});

document.getElementById('walk-btn').addEventListener('click', () => {
  currentMode = 'walk';
  document.getElementById('walk-btn').classList.add('active');
  document.getElementById('drive-btn').classList.remove('active');
});

document.getElementById('drive-btn').addEventListener('click', () => {
  currentMode = 'drive';
  document.getElementById('drive-btn').classList.add('active');
  document.getElementById('walk-btn').classList.remove('active');
});

document.getElementById('search-btn').addEventListener('click', () => {
  if (!originCoord) {
    updateStatus('Still finding your location — please wait a moment and try again.');
    return;
  }
  if (!destCoord) {
    updateStatus('Please select a destination from the suggestions list.');
    return;
  }

  updateStatus('Calculating route...');
  calculateAndDrawRoute();

  // Switch panels: hide search, show nav.
  document.getElementById('search-panel').classList.add('hidden');
  document.getElementById('nav-panel').classList.remove('hidden');
});


// ── NAV PANEL BUTTONS ────────────────────────────────────────────────

document.getElementById('start-nav-btn').addEventListener('click', () => {
  if (!originCoord) {
    updateStatus('Waiting for your location...');
    return;
  }

  followMode = true;

  // Build a ~20-meter-wide view around the user's current position by
  // projecting four points 20m out in each cardinal direction with Turf,
  // then fitting the camera to that box — precise, rather than a guessed
  // zoom number.
  const north = turf.destination(originCoord, 0.02, 0, { units: 'kilometers' });
  const south = turf.destination(originCoord, 0.02, 180, { units: 'kilometers' });
  const east = turf.destination(originCoord, 0.02, 90, { units: 'kilometers' });
  const west = turf.destination(originCoord, 0.02, 270, { units: 'kilometers' });

  const closeBbox = turf.bbox(turf.featureCollection([north, south, east, west]));

  map.fitBounds(closeBbox, { pitch: 60, duration: 1000 });

  updateStatus('Navigating — follow the blue line.');
});

document.getElementById('recenter-btn').addEventListener('click', () => {
  if (!originCoord) return;
  followMode = true;
  map.easeTo({ center: originCoord, duration: 800 }); // keeps current zoom, per the "unless the user zooms out" requirement
});

document.getElementById('search-again-btn').addEventListener('click', () => {
  followMode = false;
  document.getElementById('nav-panel').classList.add('hidden');
  document.getElementById('search-panel').classList.remove('hidden');
  destInput.value = '';
  destCoord = null;
  clearRoute();
  updateStatus('Search for a destination to begin.');
});

document.getElementById('reset-btn').addEventListener('click', () => {
  followMode = false;
  destCoord = null;
  clearRoute();
  destInput.value = '';
  document.getElementById('nav-panel').classList.add('hidden');
  document.getElementById('search-panel').classList.remove('hidden');
  updateStatus('Search for a destination to begin.');
});


// ── UI HELPER FUNCTIONS ────────────────────────────────────────────

function updateStatus(message) {
  document.getElementById('status').textContent = message;
}

function clearRoute() {
  map.getSource('route-line-source').setData({ type: 'FeatureCollection', features: [] });
  document.getElementById('route-summary').textContent = '';
  document.getElementById('route-steps').innerHTML = '';
}


// ── ROUTE CALCULATION AND DRAWING ──────────────────────────────────

function calculateAndDrawRoute() {
  const graph = currentMode === 'walk' ? walkGraph : driveGraph;

  const nearestStart = findNearestNode(graph, originCoord);
  const nearestEnd = findNearestNode(graph, destCoord);

  const route = findShortestPath(graph, nearestStart, nearestEnd);

  if (!route) {
    updateStatus('No route found for this mode. Try a different destination or mode.');
    return;
  }

  drawRoute(route);
  fitMapToRoute(route);

  const totalMeters = calculateTotalDistance(route);
  const speed = currentMode === 'walk' ? WALK_SPEED_MPS : DRIVE_SPEED_MPS;
  const minutes = Math.max(1, Math.round(totalMeters / speed / 60));

  document.getElementById('route-summary').textContent =
    `${Math.round(totalMeters)}m • approx. ${minutes} min ${currentMode === 'walk' ? 'walk' : 'drive'}`;

  const steps = generateInstructions(route);
  const stepsList = document.getElementById('route-steps');
  stepsList.innerHTML = '';
  steps.forEach(stepText => {
    const li = document.createElement('li');
    li.textContent = stepText;
    stepsList.appendChild(li);
  });

  updateStatus('Route ready. Tap Start Navigation when you\'re ready to go.');
}

function findNearestNode(graph, clickCoord) {
  let nearest = null;
  let minDist = Infinity;

  Object.keys(graph).forEach(nodeKey => {
    const nodeCoord = nodeKey.split(',').map(Number);
    const dist = turf.distance(clickCoord, nodeCoord, { units: 'meters' });
    if (dist < minDist) {
      minDist = dist;
      nearest = nodeCoord;
    }
  });

  return nearest;
}

function drawRoute(routeCoords) {
  const routeGeoJSON = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: routeCoords
        },
        properties: {}
      }
    ]
  };

  map.getSource('route-line-source').setData(routeGeoJSON);
}

function fitMapToRoute(routeCoords) {
  const routeLine = turf.lineString(routeCoords);
  const bbox = turf.bbox(routeLine);

  map.fitBounds(bbox, {
    padding: { top: 50, bottom: 50, left: 50, right: 280 },
    pitch: 60,
    duration: 1000
  });
}


function calculateTotalDistance(routeCoords) {
  let total = 0;
  for (let i = 0; i < routeCoords.length - 1; i++) {
    total += turf.distance(routeCoords[i], routeCoords[i + 1], { units: 'meters' });
  }
  return total;
}

function generateInstructions(routeCoords) {
  const instructions = [];
  let segmentDist = 0;

  for (let i = 0; i < routeCoords.length - 1; i++) {
    segmentDist += turf.distance(routeCoords[i], routeCoords[i + 1], { units: 'meters' });

    if (i < routeCoords.length - 2) {
      const bearingIn = turf.bearing(routeCoords[i], routeCoords[i + 1]);
      const bearingOut = turf.bearing(routeCoords[i + 1], routeCoords[i + 2]);

      let turnAngle = bearingOut - bearingIn;
      if (turnAngle > 180) turnAngle -= 360;
      if (turnAngle < -180) turnAngle += 360;

      if (Math.abs(turnAngle) > 25) {
        const direction = turnAngle > 0 ? 'right' : 'left';
        instructions.push(`Continue for ${Math.round(segmentDist)}m, then turn ${direction}`);
        segmentDist = 0;
      }
    }
  }

  instructions.push(`Continue for ${Math.round(segmentDist)}m to arrive at your destination`);
  return instructions;
}


function buildGraph(geojson, modeField) {
  const graph = {};

  function snap(coord) {
    return coord.map(n => n.toFixed(6)).join(',');
  }

  geojson.features.forEach(feature => {
    if (feature.properties[modeField] !== 1) return;

    feature.geometry.coordinates.forEach(line => {
      for (let i = 0; i < line.length - 1; i++) {
        const nodeA = snap(line[i]);
        const nodeB = snap(line[i + 1]);
        const dist = turf.distance(line[i], line[i + 1], { units: 'meters' });

        if (!graph[nodeA]) graph[nodeA] = [];
        if (!graph[nodeB]) graph[nodeB] = [];

        graph[nodeA].push({ node: nodeB, weight: dist });
        graph[nodeB].push({ node: nodeA, weight: dist });
      }
    });
  });

  return graph;
}

function countIslands(graph) {
  const visited = new Set();
  let islands = 0;

  Object.keys(graph).forEach(startNode => {
    if (visited.has(startNode)) return;
    islands++;
    const stack = [startNode];
    while (stack.length > 0) {
      const current = stack.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      graph[current].forEach(neighbor => {
        if (!visited.has(neighbor.node)) stack.push(neighbor.node);
      });
    }
  });

  return islands;
}

function findShortestPath(graph, startCoord, endCoord) {
  const start = startCoord.map(n => n.toFixed(6)).join(',');
  const end = endCoord.map(n => n.toFixed(6)).join(',');

  const distances = {};
  const previous = {};
  const unvisited = new Set(Object.keys(graph));

  Object.keys(graph).forEach(node => { distances[node] = Infinity; });
  distances[start] = 0;

  while (unvisited.size > 0) {
    let current = null;
    let currentDist = Infinity;
    unvisited.forEach(node => {
      if (distances[node] < currentDist) {
        currentDist = distances[node];
        current = node;
      }
    });

    if (current === null || current === end) break;
    unvisited.delete(current);

    graph[current].forEach(neighbor => {
      const alt = distances[current] + neighbor.weight;
      if (alt < distances[neighbor.node]) {
        distances[neighbor.node] = alt;
        previous[neighbor.node] = current;
      }
    });
  }

  if (distances[end] === Infinity) return null;

  const path = [end];
  let step = end;
  while (step !== start) {
    step = previous[step];
    path.unshift(step);
  }

  return path.map(n => n.split(',').map(Number));
}