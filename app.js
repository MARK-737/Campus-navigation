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
let destName = null;

const WALK_SPEED_MPS = 1.4;
const DRIVE_SPEED_MPS = 8.3;

let buildingList = [];

let userMarker = null;
let watchId = null;

let followMode = false;

let navigationActive = false;
let currentRoute = [];
let turnPoints = [];

let compassActive = false;
let lastHeading = null;

let followResumeTimer = null;
const FOLLOW_RESUME_DELAY_MS = 4000;

let dataReady = {
  buildings: false,
  network: false
};


// NEW: calculates a pixel offset so the camera centers the user's real
// position within the VISIBLE map area, not the full canvas — since the
// panel can cover a large portion of the screen (especially on mobile,
// where it's bottom-anchored and up to 70% of the screen height). This
// is the actual fix for "recenter shows somewhere else" — the map WAS
// centering correctly on the full canvas, it was just landing behind
// the panel.
function getFollowOffset() {
  const panel = document.getElementById('panel');
  if (!panel) return [0, 0];

  const panelRect = panel.getBoundingClientRect();
  const panelVisibleHeight = panelRect.height;

  if (window.innerWidth <= 600) {
    // Mobile: panel is bottom-anchored, covering the lower portion of
    // the screen. Shift the target UP (negative Y) by half the panel's
    // height, so it centers within the remaining visible strip above it.
    return [0, -(panelVisibleHeight / 2)];
  } else {
    // Desktop: panel is a smaller top-left box. Its visual impact on
    // centering is minor, but we still nudge slightly right/down away
    // from it for consistency, using a fraction of its width.
    return [panelRect.width / 4, 0];
  }
}


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
      'fill-extrusion-color': [
        'match', ['get', 'Name'],
        '__none__', '#8899aa',
        '#8899aa'
      ],
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

  map.on('click', 'buildings-3d', (e) => {
    if (!dataReady.buildings || !dataReady.network) return;
    destCoord = [e.lngLat.lng, e.lngLat.lat];
    destName = e.features[0].properties.Name || null;
    document.getElementById('dest-input').value = destName || 'Selected on map';
    document.getElementById('suggestions').innerHTML = '';
    if (destName) highlightDestination(destName);
  });

  startLiveLocation();

  map.on('dragstart', () => {
    followMode = false;
    scheduleFollowResume();
  });
  map.on('zoomstart', (e) => {
    if (e.originalEvent) {
      followMode = false;
      scheduleFollowResume();
    }
  });

});


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


function scheduleFollowResume() {
  if (!navigationActive) return;

  clearTimeout(followResumeTimer);
  followResumeTimer = setTimeout(() => {
    followMode = true;
    lastHeading = null;
    if (originCoord) {
      // CHANGED: now passes the panel-aware offset, same as every other
      // recentering call below.
      map.easeTo({ center: originCoord, offset: getFollowOffset(), duration: 800 });
    }
  }, FOLLOW_RESUME_DELAY_MS);
}


function highlightDestination(name) {
  map.setPaintProperty('buildings-3d', 'fill-extrusion-color', [
    'match', ['get', 'Name'],
    name, '#e63946',
    '#8899aa'
  ]);
  map.setPaintProperty('buildings-3d', 'fill-extrusion-height', [
    'match', ['get', 'Name'],
    name, ['*', ['coalesce', ['get', 'Building_H'], 3], 1.6],
    ['get', 'Building_H']
  ]);
}

function clearHighlight() {
  map.setPaintProperty('buildings-3d', 'fill-extrusion-color', '#8899aa');
  map.setPaintProperty('buildings-3d', 'fill-extrusion-height', ['get', 'Building_H']);
}


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
        const el = document.createElement('div');
        el.className = 'user-dot-wrapper';
        el.innerHTML = '<div class="user-dot-pulse"></div><div class="user-dot-core"></div>';
        userMarker = new mapboxgl.Marker({ element: el })
          .setLngLat(liveCoord)
          .addTo(map);
      } else {
        userMarker.setLngLat(liveCoord);
      }

      // CHANGED: added the panel-aware offset here too — this is the
      // continuous re-centering that runs on every GPS update while
      // followMode is on.
      if (followMode) {
        map.easeTo({ center: liveCoord, offset: getFollowOffset(), duration: 800 });
      }

      if (navigationActive) {
        checkNavigationProgress(liveCoord);
        updateRouteLineProgress(liveCoord);
      }
    },
    (error) => {
      updateStatus('Could not get your location. Check permissions and try again.');
      console.error('Geolocation error:', error);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}


function updateRouteLineProgress(liveCoord) {
  if (currentRoute.length < 2) return;

  const fullLine = turf.lineString(currentRoute);
  const userPoint = turf.point(liveCoord);
  const nearest = turf.nearestPointOnLine(fullLine, userPoint);
  const endPoint = turf.point(currentRoute[currentRoute.length - 1]);

  let remaining;
  try {
    remaining = turf.lineSlice(nearest, endPoint, fullLine);
  } catch (err) {
    return;
  }

  map.getSource('route-line-source').setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: remaining.geometry, properties: {} }]
  });
}


function requestCompass() {
  if (compassActive) return;

  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission()
      .then(response => {
        if (response === 'granted') {
          window.addEventListener('deviceorientation', handleOrientation, true);
          compassActive = true;
        }
      })
      .catch(err => console.error('Compass permission error:', err));
  } else {
    window.addEventListener('deviceorientation', handleOrientation, true);
    compassActive = true;
  }
}

function handleOrientation(event) {
  if (!navigationActive || !followMode) return;

  let heading = event.webkitCompassHeading;
  if (heading === undefined || heading === null) {
    if (event.alpha === null) return;
    heading = 360 - event.alpha;
  }

  if (lastHeading !== null) {
    let diff = Math.abs(heading - lastHeading);
    if (diff > 180) diff = 360 - diff;
    if (diff < 4) return;
  }

  lastHeading = heading;
  map.setBearing(heading);
}


function speak(text) {
  if (!window.speechSynthesis) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.0;
  window.speechSynthesis.speak(utterance);
}

function computeTurnPoints(routeCoords, angleThreshold = 45, minSegmentMeters = 10) {
  const rawTurns = [];

  for (let i = 1; i < routeCoords.length - 1; i++) {
    const bearingIn = turf.bearing(routeCoords[i - 1], routeCoords[i]);
    const bearingOut = turf.bearing(routeCoords[i], routeCoords[i + 1]);

    let turnAngle = bearingOut - bearingIn;
    if (turnAngle > 180) turnAngle -= 360;
    if (turnAngle < -180) turnAngle += 360;

    if (Math.abs(turnAngle) > angleThreshold) {
      rawTurns.push({
        index: i,
        coord: routeCoords[i],
        direction: turnAngle > 0 ? 'right' : 'left'
      });
    }
  }

  const filtered = [];
  for (let k = 0; k < rawTurns.length; k++) {
    const thisTurn = rawTurns[k];
    const nextIndex = (k + 1 < rawTurns.length) ? rawTurns[k + 1].index : routeCoords.length - 1;

    let segLen = 0;
    for (let j = thisTurn.index; j < nextIndex; j++) {
      segLen += turf.distance(routeCoords[j], routeCoords[j + 1], { units: 'meters' });
    }

    if (segLen >= minSegmentMeters) {
      filtered.push({ ...thisTurn, announcedUpcoming: false, announcedNow: false });
    }
  }

  return filtered;
}

function checkNavigationProgress(liveCoord) {
  if (!destCoord) return;

  const distToDest = turf.distance(liveCoord, destCoord, { units: 'meters' });
  if (distToDest < 15) {
    speak('You have arrived at your destination.');
    navigationActive = false;
    return;
  }

  const nextTurn = turnPoints.find(t => !t.announcedNow);
  if (!nextTurn) return;

  const distToTurn = turf.distance(liveCoord, nextTurn.coord, { units: 'meters' });

  if (distToTurn <= 5 && !nextTurn.announcedNow) {
    speak(`Turn ${nextTurn.direction} now, then continue straight.`);
    nextTurn.announcedNow = true;
  } else if (distToTurn <= 20 && !nextTurn.announcedUpcoming) {
    const roundedDist = Math.round(distToTurn / 5) * 5;
    speak(`In ${roundedDist} meters, turn ${nextTurn.direction}.`);
    nextTurn.announcedUpcoming = true;
  }
}


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
    destCoord = null;
    destName = null;
    clearHighlight();
    return;
  }

  const matches = buildingList.filter(b => b.name.toLowerCase().includes(query)).slice(0, 6);

  matches.forEach(match => {
    const item = document.createElement('div');
    item.className = 'suggestion-item';
    item.textContent = match.name;
    item.addEventListener('click', () => {
      destInput.value = match.name;
      destCoord = match.coord;
      destName = match.name;
      suggestionsBox.innerHTML = '';
      highlightDestination(match.name);
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

  document.getElementById('search-controls').classList.add('hidden');
  document.getElementById('nav-controls').classList.remove('hidden');
});


document.getElementById('start-nav-btn').addEventListener('click', () => {
  if (!originCoord || currentRoute.length === 0) {
    updateStatus('Waiting for your location and route...');
    return;
  }

  followMode = true;
  navigationActive = true;
  lastHeading = null;

  requestCompass();

  map.stop();

  // CHANGED: even without a forced zoom, we still explicitly re-center
  // on the user immediately when navigation starts — WITH the panel
  // offset — so the very first moment of navigation already shows the
  // user's dot in the visible area, not just wherever the map happened
  // to be looking beforehand.
  map.easeTo({ center: originCoord, offset: getFollowOffset(), duration: 800 });

  updateStatus('Navigating — follow the blue line.');

  if (turnPoints.length > 0) {
    speak('Navigation started. Continue straight.');
  } else {
    speak('Navigation started. Head straight to your destination.');
  }
});

document.getElementById('recenter-btn').addEventListener('click', () => {
  if (!originCoord) return;
  followMode = true;
  lastHeading = null;
  clearTimeout(followResumeTimer);
  map.stop();
  // CHANGED: offset applied here too — this was the main visible symptom.
  map.easeTo({ center: originCoord, offset: getFollowOffset(), duration: 800 });
});

document.getElementById('search-again-btn').addEventListener('click', () => {
  followMode = false;
  navigationActive = false;
  currentRoute = [];
  turnPoints = [];
  clearTimeout(followResumeTimer);

  document.getElementById('nav-controls').classList.add('hidden');
  document.getElementById('search-controls').classList.remove('hidden');

  document.getElementById('route-summary').textContent = 'Search a destination to see distance and ETA.';

  destInput.value = '';
  destCoord = null;
  destName = null;
  clearHighlight();
  clearRoute();
  updateStatus('Search for a destination to begin.');
});


function updateStatus(message) {
  document.getElementById('status').textContent = message;
}

function clearRoute() {
  map.getSource('route-line-source').setData({ type: 'FeatureCollection', features: [] });
}


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

  currentRoute = route;
  turnPoints = computeTurnPoints(route);

  const totalMeters = calculateTotalDistance(route);

  const straightLineMeters = turf.distance(originCoord, destCoord, { units: 'meters' });
  console.log(`[Route debug] Mode: ${currentMode}`);
  console.log(`[Route debug] Straight-line distance: ${Math.round(straightLineMeters)}m`);
  console.log(`[Route debug] Actual route distance: ${Math.round(totalMeters)}m`);
  console.log(`[Route debug] Ratio (route/straight-line): ${(totalMeters / straightLineMeters).toFixed(2)}`);
  console.log('[Route debug] Nearest start node used:', nearestStart);
  console.log('[Route debug] Nearest end node used:', nearestEnd);
  console.log('[Route debug] Full route coordinates (paste into geojson.io to visualize):');
  console.log(JSON.stringify({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: route },
    properties: {}
  }));

  const speed = currentMode === 'walk' ? WALK_SPEED_MPS : DRIVE_SPEED_MPS;
  const minutes = Math.max(1, Math.round(totalMeters / speed / 60));

  document.getElementById('route-summary').textContent =
    `${Math.round(totalMeters)}m • approx. ${minutes} min ${currentMode === 'walk' ? 'walk' : 'drive'}`;

  document.getElementById('start-nav-btn').disabled = false;
  document.getElementById('recenter-btn').disabled = false;

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

function calculateTotalDistance(routeCoords) {
  let total = 0;
  for (let i = 0; i < routeCoords.length - 1; i++) {
    total += turf.distance(routeCoords[i], routeCoords[i + 1], { units: 'meters' });
  }
  return total;
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