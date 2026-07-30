// ── SETUP ──────────────────────────────────────────────────────────
mapboxgl.accessToken = 'pk.eyJ1IjoibWFyay10ZWUiLCJhIjoiY21zN2l3cHk2MDRjazM5cGxpc2hnbmY1cSJ9.VdHqEZXBn5LJ4QvFkUAtXw'; // ⚠️ MANUAL INPUT NEEDED: your real Mapbox token

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/standard',
  center: [3.82550, 7.24072], // ⚠️ MANUAL INPUT NEEDED: your real campus coordinates
  zoom: 17,
  pitch: 60,
  bearing: -20
});

const geolocateControl = new mapboxgl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true,
  showUserHeading: true
});
map.addControl(geolocateControl);

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

// NEW: tracks whether each required dataset has finished loading
// successfully, so we know exactly when it's safe to hide the
// loading overlay and enable the controls.
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
      'line-color': '#ffcc00',
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
      'line-color': '#e63946',
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
      'line-color': '#00c853',
      'line-width': 6,
      'line-opacity': 0.9
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

  // NEW: Buildings fetch now has a .catch() — if this file fails to
  // load (wrong path, server error, missing file after deployment),
  // the user sees a clear message instead of a silent broken app.
  fetch('data/data/data/Buildings.geojson')
    .then(res => {
      if (!res.ok) throw new Error(`Server responded with ${res.status}`);
      return res.json();
    })
    .then(data => {
      buildingList = extractNamedLocations(data, 'Building');
      buildingList.sort((a, b) => a.name.localeCompare(b.name));
      populateDropdown('origin-select', buildingList);
      populateDropdown('dest-select', buildingList);

      dataReady.buildings = true;
      checkAllDataReady();
    })
    .catch(err => {
      console.error('Failed to load Buildings.geojson:', err);
      showLoadError('Could not load building data. Please refresh, or check your connection.');
    });

  // NEW: same error-handling pattern applied to the routing network fetch.
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

  map.on('click', 'buildings-3d', (e) => {
    // NEW: ignore clicks entirely until data has finished loading,
    // since originCoord/destCoord being set early would let a user
    // trigger a route calculation against an empty graph.
    if (!dataReady.buildings || !dataReady.network) return;

    const clickedCoord = [e.lngLat.lng, e.lngLat.lat];

    if (!originCoord) {
      originCoord = clickedCoord;
      updateStatus('Origin set. Now click your destination.');
    } else if (!destCoord) {
      destCoord = clickedCoord;
      updateStatus('Calculating route...');
      calculateAndDrawRoute();
    } else {
      originCoord = clickedCoord;
      destCoord = null;
      clearRoute();
      updateStatus('Origin set. Now click your destination.');
    }
  });


  const layerToggleMap = {
    'toggle-buildings': 'buildings-3d',
    'toggle-paths': 'paths-line',
    'toggle-roads': 'roads-line',
    'toggle-landmarks': 'landmarks-point'
  };

  Object.keys(layerToggleMap).forEach(checkboxId => {
    document.getElementById(checkboxId).addEventListener('change', (e) => {
      const layerId = layerToggleMap[checkboxId];
      map.setLayoutProperty(layerId, 'visibility', e.target.checked ? 'visible' : 'none');
    });
  });

});


// ── NEW: LOADING STATE MANAGEMENT ───────────────────────────────────

// Called after EITHER dataset finishes loading. Only actually hides
// the overlay and enables controls once BOTH are ready.
function checkAllDataReady() {
  if (dataReady.buildings && dataReady.network) {
    document.getElementById('loading-overlay').classList.add('hidden');
    document.getElementById('origin-select').disabled = false;
    document.getElementById('dest-select').disabled = false;
    document.getElementById('locate-btn').disabled = false;
    updateStatus('Click a building, choose From/To, or use your location.');
  }
}

// Shows a clear, permanent error message in place of the loading
// spinner, if a required file fails to load. Controls stay disabled,
// since the app genuinely cannot function without this data.
function showLoadError(message) {
  document.getElementById('loading-box').innerHTML = `<p style="color:#c0392b;">${message}</p>`;
}


document.getElementById('locate-btn').addEventListener('click', () => {
  if (!navigator.geolocation) {
    updateStatus('Location is not supported on this browser.');
    return;
  }

  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
  }

  updateStatus('Getting your location...');

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      const liveCoord = [position.coords.longitude, position.coords.latitude];
      originCoord = liveCoord;

      if (!userMarker) {
        userMarker = new mapboxgl.Marker({ color: '#2a72d4' })
          .setLngLat(liveCoord)
          .addTo(map);
        updateStatus('Location found! Now choose or click a destination.');
        map.flyTo({ center: liveCoord, zoom: 18 });
        checkAndCalculate();
      } else {
        userMarker.setLngLat(liveCoord);
        if (destCoord) {
          calculateAndDrawRoute();
        }
      }
    },
    (error) => {
      updateStatus('Could not get your location. Check permissions and try again.');
      console.error('Geolocation error:', error);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});


function extractNamedLocations(geojson, typeLabel) {
  const results = [];

  geojson.features.forEach(feature => {
    const name = feature.properties.Name;
    if (!name) return;

    const centroid = turf.centroid(feature);
    const coord = centroid.geometry.coordinates;

    results.push({ name, coord, type: typeLabel });
  });

  return results;
}

function populateDropdown(selectId, locations) {
  const select = document.getElementById(selectId);
  select.innerHTML = '<option value="">-- Select a building --</option>';
  locations.forEach((location, index) => {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = location.name;
    select.appendChild(option);
  });
}

document.getElementById('origin-select').addEventListener('change', (e) => {
  if (e.target.value === '') return;
  originCoord = buildingList[e.target.value].coord;
  checkAndCalculate();
});

document.getElementById('dest-select').addEventListener('change', (e) => {
  if (e.target.value === '') return;
  destCoord = buildingList[e.target.value].coord;
  checkAndCalculate();
});

function checkAndCalculate() {
  if (originCoord && destCoord) {
    updateStatus('Calculating route...');
    calculateAndDrawRoute();
  } else if (originCoord) {
    updateStatus('Origin set. Now choose or click a destination.');
  }
}


function updateStatus(message) {
  document.getElementById('status').textContent = message;
}

function clearRoute() {
  map.getSource('route-line-source').setData({ type: 'FeatureCollection', features: [] });
  document.getElementById('route-summary').textContent = '';
  document.getElementById('route-steps').innerHTML = '';
}

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

document.getElementById('reset-btn').addEventListener('click', () => {
  originCoord = null;
  destCoord = null;
  clearRoute();
  document.getElementById('origin-select').value = '';
  document.getElementById('dest-select').value = '';
  updateStatus('Click a building, choose From/To, or use your location.');

  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (userMarker) {
    userMarker.remove();
    userMarker = null;
  }
});


function calculateAndDrawRoute() {
  const graph = currentMode === 'walk' ? walkGraph : driveGraph;

  const nearestStart = findNearestNode(graph, originCoord);
  const nearestEnd = findNearestNode(graph, destCoord);

  const route = findShortestPath(graph, nearestStart, nearestEnd);

  if (!route) {
    updateStatus('No route found for this mode. Try Reset or switch mode.');
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

  updateStatus('Route found! Click Reset to try another.');
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
    padding: { top: 50, bottom: 50, left: 300, right: 50 },
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




































