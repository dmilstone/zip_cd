(function () {
  "use strict";

  const LEGISLATORS_URL = "https://unitedstates.github.io/congress-legislators/legislators-current.json";
  const FEC_CANDIDATES_URL = "https://api.open.fec.gov/v1/candidates/";
  // DEMO_KEY is heavily rate limited; a free api.data.gov key allows 1,000 requests per hour.
  const FEC_API_KEY = window.FEC_API_KEY || "DEMO_KEY";
  const CURRENT_YEAR = new Date().getFullYear();
  const ELECTION_YEAR = CURRENT_YEAR + (CURRENT_YEAR % 2);

  const NAME_HONORIFIC = /^(mr|mrs|ms|miss|dr|hon|rev)\.?$/i;
  const NAME_SUFFIX = /^(jr|sr|ii|iii|iv)\.?$/i;

  // Sources report parties inconsistently ("Democrat", "DEMOCRATIC PARTY", "DEM"), so match loosely.
  const PARTY_CLASSES = [
    [/^dem/i, "party-dem"],
    [/^rep/i, "party-rep"],
  ];

  const ZIP_PATTERN = /^\d{5}$/;

  const TIGERWEB_BASE = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb";
  const ZCTA_QUERY_URL = TIGERWEB_BASE + "/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/1/query";
  // Legislative layer 0 = 120th Congress (2026 election districts); layer 4 = 119th Congress.
  const CD_QUERY_URL = TIGERWEB_BASE + "/Legislative/MapServer/0/query";
  const REQUEST_TIMEOUT_MS = 20000;
  // Degrees; generalizes returned district outlines (a whole-state district is ~190 KB at full resolution).
  const CD_MAX_ALLOWABLE_OFFSET = 0.0002;

  const DISTRICT_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#7c3aed", "#ca8a04", "#0891b2", "#db2777", "#ea580c"];

  const POLYGON_STYLE = {
    base: { weight: 2, opacity: 0.9, fillOpacity: 0.25, dashArray: null },
    hover: { weight: 3, fillOpacity: 0.4 },
    selected: { weight: 4, fillOpacity: 0.55, dashArray: null },
  };

  const ZCTA_STYLE = {
    color: "#111827",
    weight: 2,
    opacity: 0.9,
    dashArray: "6 4",
    fill: false,
    interactive: false,
  };

  const STATES_BY_FIPS = {
    "01": ["AL", "Alabama"], "02": ["AK", "Alaska"], "04": ["AZ", "Arizona"], "05": ["AR", "Arkansas"],
    "06": ["CA", "California"], "08": ["CO", "Colorado"], "09": ["CT", "Connecticut"], "10": ["DE", "Delaware"],
    "11": ["DC", "District of Columbia"], "12": ["FL", "Florida"], "13": ["GA", "Georgia"], "15": ["HI", "Hawaii"],
    "16": ["ID", "Idaho"], "17": ["IL", "Illinois"], "18": ["IN", "Indiana"], "19": ["IA", "Iowa"],
    "20": ["KS", "Kansas"], "21": ["KY", "Kentucky"], "22": ["LA", "Louisiana"], "23": ["ME", "Maine"],
    "24": ["MD", "Maryland"], "25": ["MA", "Massachusetts"], "26": ["MI", "Michigan"], "27": ["MN", "Minnesota"],
    "28": ["MS", "Mississippi"], "29": ["MO", "Missouri"], "30": ["MT", "Montana"], "31": ["NE", "Nebraska"],
    "32": ["NV", "Nevada"], "33": ["NH", "New Hampshire"], "34": ["NJ", "New Jersey"], "35": ["NM", "New Mexico"],
    "36": ["NY", "New York"], "37": ["NC", "North Carolina"], "38": ["ND", "North Dakota"], "39": ["OH", "Ohio"],
    "40": ["OK", "Oklahoma"], "41": ["OR", "Oregon"], "42": ["PA", "Pennsylvania"], "44": ["RI", "Rhode Island"],
    "45": ["SC", "South Carolina"], "46": ["SD", "South Dakota"], "47": ["TN", "Tennessee"], "48": ["TX", "Texas"],
    "49": ["UT", "Utah"], "50": ["VT", "Vermont"], "51": ["VA", "Virginia"], "53": ["WA", "Washington"],
    "54": ["WV", "West Virginia"], "55": ["WI", "Wisconsin"], "56": ["WY", "Wyoming"],
    "60": ["AS", "American Samoa"], "66": ["GU", "Guam"], "69": ["MP", "Northern Mariana Islands"],
    "72": ["PR", "Puerto Rico"], "78": ["VI", "U.S. Virgin Islands"],
  };

  const els = {
    form: document.getElementById("zip-form"),
    input: document.getElementById("zip-input"),
    submit: document.getElementById("zip-submit"),
    error: document.getElementById("zip-error"),
    hint: document.getElementById("zip-hint"),
    overlay: document.getElementById("modal-overlay"),
    modal: document.getElementById("district-modal"),
    modalTitle: document.getElementById("modal-title"),
    modalDesc: document.getElementById("modal-desc"),
    closeBtn: document.getElementById("modal-close"),
    cancelBtn: document.getElementById("modal-cancel"),
    mapEl: document.getElementById("map"),
    list: document.getElementById("district-list"),
    status: document.getElementById("selection-status"),
    candidateOverlay: document.getElementById("candidate-overlay"),
    candidateModal: document.getElementById("candidate-modal"),
    candidateEyebrow: document.getElementById("candidate-eyebrow"),
    candidateTitle: document.getElementById("candidate-title"),
    candidateDesc: document.getElementById("candidate-desc"),
    candidateList: document.getElementById("candidate-list"),
    candidateCloseBtn: document.getElementById("candidate-close"),
    candidateDoneBtn: document.getElementById("candidate-done"),
  };

  const state = {
    zip: null,
    entry: null,
    selectedId: null,
    returnFocusTo: null,
    requestSeq: 0,
    abortController: null,
    candidateSeq: 0,
    candidateAbort: null,
  };

  let representativesPromise = null;
  const fecCandidatesByDistrict = new Map();

  let map = null;
  let districtLayer = null;
  let zctaLayer = null;
  const polygonById = new Map();
  const buttonById = new Map();

  // ---------- Helpers ----------

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      Object.entries(props).forEach(([key, value]) => {
        if (value == null) return;
        if (key === "className") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key === "style") Object.assign(node.style, value);
        else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value);
      });
    }
    (children || []).forEach((child) => {
      if (child == null) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  // ---------- TIGERweb API ----------

  async function queryTigerweb(url, params, signal) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      signal,
    });
    if (!response.ok) throw new Error("TIGERweb HTTP " + response.status);
    const data = await response.json();
    // ArcGIS reports query errors with HTTP 200 and an `error` body.
    if (data.error) throw new Error("TIGERweb: " + (data.error.message || "query failed"));
    return data;
  }

  function fetchZcta(zip, signal) {
    return queryTigerweb(
      ZCTA_QUERY_URL,
      {
        where: "ZCTA5='" + zip + "'",
        outFields: "ZCTA5,INTPTLAT,INTPTLON",
        returnGeometry: "true",
        outSR: "4326",
        f: "geojson",
      },
      signal
    ).then((data) => (data.features && data.features[0]) || null);
  }

  function fetchIntersectingDistricts(geometry, signal) {
    return queryTigerweb(
      CD_QUERY_URL,
      {
        geometry: JSON.stringify(toEsriPolygon(geometry)),
        geometryType: "esriGeometryPolygon",
        inSR: "4326",
        // DE-9IM "interiors intersect": excludes districts that merely share a boundary with the ZCTA.
        spatialRel: "esriSpatialRelRelation",
        relationParam: "T********",
        outFields: "GEOID,STATE,NAME,CDSESSN,INTPTLAT,INTPTLON",
        returnGeometry: "true",
        outSR: "4326",
        maxAllowableOffset: String(CD_MAX_ALLOWABLE_OFFSET),
        geometryPrecision: "5",
        f: "geojson",
      },
      signal
    ).then((data) => data.features || []);
  }

  async function fetchDistricts(zip, signal) {
    const zcta = await fetchZcta(zip, signal);
    if (!zcta || !zcta.geometry) return null;

    const features = await fetchIntersectingDistricts(zcta.geometry, signal);
    return buildEntry(zip, zcta, features);
  }

  // ---------- Geometry ----------

  function polygonsOf(geometry) {
    if (geometry.type === "Polygon") return [geometry.coordinates];
    if (geometry.type === "MultiPolygon") return geometry.coordinates;
    return [];
  }

  // Shoelace sum over [lng, lat] positions; positive = counter-clockwise.
  function signedArea(ring) {
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
    }
    return -sum / 2;
  }

  // Esri polygons need clockwise outer rings and counter-clockwise holes.
  function toEsriPolygon(geometry) {
    const rings = [];
    polygonsOf(geometry).forEach((polygon) => {
      polygon.forEach((ring, index) => {
        const isOuter = index === 0;
        const isClockwise = signedArea(ring) < 0;
        rings.push(isOuter === isClockwise ? ring : ring.slice().reverse());
      });
    });
    return { rings, spatialReference: { wkid: 4326 } };
  }

  // Planar area-weighted centroid across all polygons (holes subtract). Returns [lat, lng] for Leaflet.
  function computeCentroid(geometry) {
    let area = 0;
    let cx = 0;
    let cy = 0;
    polygonsOf(geometry).forEach((polygon) => {
      polygon.forEach((ring, index) => {
        const sign = (index === 0 ? 1 : -1) * Math.sign(signedArea(ring));
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [x0, y0] = ring[j];
          const [x1, y1] = ring[i];
          const cross = (x0 * y1 - x1 * y0) * sign;
          area += cross;
          cx += (x0 + x1) * cross;
          cy += (y0 + y1) * cross;
        }
      });
    });
    if (area === 0) return null;
    // area holds 2A, so centroid = sum / (3 * 2A).
    return [cy / (3 * area), cx / (3 * area)];
  }

  function internalPoint(props) {
    const lat = parseFloat(props && props.INTPTLAT);
    const lng = parseFloat(props && props.INTPTLON);
    return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
  }

  // Census internal points are guaranteed to fall inside the shape; centroids of concave shapes may not.
  function centerOf(feature) {
    return internalPoint(feature.properties) || computeCentroid(feature.geometry);
  }

  // ---------- Feature -> entry mapping ----------

  function ordinal(n) {
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return n + "th";
    return n + ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
  }

  function toDistrict(feature, index) {
    const props = feature.properties || {};
    const geoid = String(props.GEOID || "");
    const stateFips = String(props.STATE || geoid.slice(0, 2));
    const cdCode = geoid.slice(2);
    const [abbr, stateName] = STATES_BY_FIPS[stateFips] || [stateFips, "State " + stateFips];

    // At-large seats and non-voting delegates are district 0 in both FEC and congress-legislators data.
    let districtNumber = 0;
    let suffix;
    let label;
    if (cdCode === "00") {
      suffix = "AL";
      label = stateName + " — At-Large";
    } else if (cdCode === "98") {
      suffix = "AL";
      label = stateName + " — At-Large (Delegate)";
    } else {
      districtNumber = parseInt(cdCode, 10);
      suffix = cdCode;
      label = stateName + " — " + ordinal(districtNumber) + " District";
    }

    return {
      id: abbr + "-" + suffix,
      state: abbr,
      stateName,
      districtNumber,
      label,
      color: DISTRICT_COLORS[index % DISTRICT_COLORS.length],
      geometry: feature.geometry,
      center: centerOf(feature),
      session: props.CDSESSN,
    };
  }

  function buildEntry(zip, zcta, features) {
    const districts = features
      // "ZZ" marks water or areas with no assigned district.
      .filter((feature) => feature.geometry && !/ZZ$/.test(String(feature.properties && feature.properties.GEOID)))
      .sort((a, b) => String(a.properties.GEOID).localeCompare(String(b.properties.GEOID)))
      .map(toDistrict);

    const stateNames = Array.from(new Set(districts.map((d) => d.stateName)));
    const session = districts[0] && districts[0].session;
    const placeParts = [stateNames.join(" / ") || "Unknown state"];
    if (session) placeParts.push(ordinal(parseInt(session, 10)) + " Congress");

    return {
      place: placeParts.join(" · "),
      center: centerOf(zcta),
      zctaGeometry: zcta.geometry,
      districts,
    };
  }

  // ---------- Validation ----------

  function validateZip(value) {
    if (!value) return "Please enter a ZIP code.";
    if (!ZIP_PATTERN.test(value)) return "ZIP codes must be exactly 5 digits.";
    return null;
  }

  // Service failures aren't the input's fault, so they can skip the invalid-field styling.
  function showError(message, markInvalid = true) {
    els.error.textContent = message;
    els.error.hidden = false;
    els.input.setAttribute("aria-invalid", String(markInvalid));
    els.input.classList.toggle("is-invalid", markInvalid);
  }

  function clearError() {
    els.error.textContent = "";
    els.error.hidden = true;
    els.input.setAttribute("aria-invalid", "false");
    els.input.classList.remove("is-invalid");
  }

  function setLoading(isLoading) {
    els.submit.disabled = isLoading;
    els.submit.textContent = isLoading ? "Looking up…" : "Look up";
  }

  // ---------- Lookup flow ----------

  async function lookup(zip) {
    const seq = ++state.requestSeq;
    if (state.abortController) state.abortController.abort();
    const controller = new AbortController();
    state.abortController = controller;
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    setLoading(true);

    let entry;
    try {
      entry = await fetchDistricts(zip, controller.signal);
    } catch (err) {
      if (seq !== state.requestSeq) return;
      setLoading(false);
      console.error(err);
      showError(
        timedOut
          ? "The Census TIGERweb service took too long to respond. Please try again."
          : "Couldn't reach the Census TIGERweb service. Please try again.",
        false
      );
      return;
    } finally {
      clearTimeout(timeoutId);
      if (state.abortController === controller) state.abortController = null;
    }

    // A newer lookup started while this one was in flight.
    if (seq !== state.requestSeq) return;
    setLoading(false);

    if (!entry) {
      showError(
        "No Census ZIP Code Tabulation Area found for " + zip +
          ". PO Box–only and single-business ZIPs have no mapped boundary."
      );
      return;
    }

    if (entry.districts.length === 0) {
      showError("No congressional district intersects ZIP " + zip + ".");
      return;
    }

    if (entry.districts.length === 1) {
      resolveDistrict(zip, entry.districts[0]);
      return;
    }

    openModal(zip, entry);
  }

  // Single entry point once a district is known, whether from an unambiguous ZIP or a map/list pick.
  function resolveDistrict(zip, district) {
    closeModal({ restoreFocus: false });
    showCandidatePopup(district, zip);
  }

  // ---------- Candidate popup ----------

  function partyClassFor(party) {
    const match = PARTY_CLASSES.find(([pattern]) => pattern.test(party || ""));
    return match ? match[1] : "party-other";
  }

  function renderCandidate(candidate) {
    const partyClass = partyClassFor(candidate.party);
    return el("li", { className: "candidate" }, [
      el("div", { className: "candidate-main" }, [
        el("p", { className: "candidate-name", text: candidate.name }),
        el("span", { className: "party-badge " + partyClass, text: candidate.party }),
      ]),
      el("p", { className: "candidate-office" }, [
        el("span", { className: "candidate-office-label", text: candidate.detailLabel }),
        candidate.detail,
      ]),
    ]);
  }

  function titleCase(text) {
    return String(text)
      .toLowerCase()
      .replace(/(^|[\s\-'])([a-z])/g, (_, sep, letter) => sep + letter.toUpperCase())
      .replace(/\b(Ii|Iii|Iv)\b/g, (numeral) => numeral.toUpperCase());
  }

  // FEC names look like "LANDER, BRAD MR." or "BITEMAN, DENNIS BO DEAN II".
  function formatFecName(raw) {
    const text = String(raw || "").trim();
    const comma = text.indexOf(",");
    if (comma === -1) return titleCase(text);
    const last = text.slice(0, comma).trim();
    const words = text
      .slice(comma + 1)
      .split(/[\s,]+/)
      .filter((word) => word && !NAME_HONORIFIC.test(word));
    const suffixes = [];
    while (words.length > 1 && NAME_SUFFIX.test(words[words.length - 1])) suffixes.unshift(words.pop());
    return titleCase([...words, last, ...suffixes].join(" "));
  }

  function representativeKey(stateCode, districtNumber) {
    return stateCode + "-" + districtNumber;
  }

  // Shared across popups (the file is ~1.5 MB), so it isn't tied to any one popup's abort signal.
  function loadRepresentatives() {
    if (!representativesPromise) {
      representativesPromise = fetch(LEGISLATORS_URL)
        .then((response) => {
          if (!response.ok) throw new Error("congress-legislators HTTP " + response.status);
          return response.json();
        })
        .then((legislators) => {
          const byDistrict = new Map();
          legislators.forEach((legislator) => {
            const term = legislator.terms[legislator.terms.length - 1];
            if (!term || term.type !== "rep") return;
            const name = legislator.name.official_full || legislator.name.first + " " + legislator.name.last;
            byDistrict.set(representativeKey(term.state, term.district || 0), {
              name,
              party: term.party || "Independent",
              termEnd: term.end,
            });
          });
          return byDistrict;
        })
        .catch((err) => {
          representativesPromise = null;
          throw err;
        });
    }
    return representativesPromise;
  }

  async function fetchIncumbent(district) {
    const byDistrict = await loadRepresentatives();
    const rep = byDistrict.get(representativeKey(district.state, district.districtNumber));
    if (!rep) return [];
    return [
      {
        name: rep.name,
        party: rep.party,
        detailLabel: "Serving: ",
        detail: "U.S. Representative" + (rep.termEnd ? ", term ends " + rep.termEnd.slice(0, 4) : ""),
      },
    ];
  }

  async function fetchFecCandidates(district, signal) {
    const cached = fecCandidatesByDistrict.get(district.id);
    if (cached) return cached;

    const params = new URLSearchParams({
      api_key: FEC_API_KEY,
      office: "H",
      state: district.state,
      district: String(district.districtNumber).padStart(2, "0"),
      election_year: String(ELECTION_YEAR),
      candidate_status: "C",
      is_active_candidate: "true",
      sort: "name",
      per_page: "100",
    });
    const response = await fetch(FEC_CANDIDATES_URL + "?" + params, { signal });
    const data = await response.json().catch(() => ({}));
    if (response.status === 429 || (data.error && data.error.code === "OVER_RATE_LIMIT")) {
      throw new Error("FEC_RATE_LIMIT");
    }
    if (!response.ok || data.error) {
      throw new Error("FEC API: " + ((data.error && data.error.message) || "HTTP " + response.status));
    }

    const candidates = (data.results || []).map((candidate) => ({
      name: formatFecName(candidate.name),
      party: titleCase(candidate.party_full || "") || "Unknown",
      detailLabel: "Running for: ",
      detail:
        "U.S. House (" + ELECTION_YEAR + ")" +
        (candidate.incumbent_challenge_full ? " · " + candidate.incumbent_challenge_full : ""),
    }));
    fecCandidatesByDistrict.set(district.id, candidates);
    return candidates;
  }

  // A section's result is undefined while loading, { rows } on success, or { error } on failure.
  function sectionNodes(title, result, emptyText) {
    const nodes = [el("li", { className: "candidate-section", text: title })];
    if (!result) nodes.push(el("li", { className: "candidate-message", text: "Loading…" }));
    else if (result.error) nodes.push(el("li", { className: "candidate-message is-error", text: result.error }));
    else if (result.rows.length === 0) nodes.push(el("li", { className: "candidate-message", text: emptyText }));
    else nodes.push(...result.rows.map(renderCandidate));
    return nodes;
  }

  function renderCandidateSections(district, zipCode, view) {
    const count = view.candidates && view.candidates.rows ? view.candidates.rows.length : null;
    els.candidateDesc.textContent =
      "ZIP " + zipCode + " · " + ELECTION_YEAR + " election" +
      (count == null ? "" : " · " + count + (count === 1 ? " candidate" : " candidates") + " filed with the FEC");
    els.candidateList.replaceChildren(
      ...sectionNodes("Current representative", view.incumbent, "No sitting representative on record; the seat may be vacant."),
      ...sectionNodes(
        ELECTION_YEAR + " candidates",
        view.candidates,
        "No active " + ELECTION_YEAR + " candidates have filed with the FEC for " + district.id + "."
      )
    );
    els.candidateList.hidden = false;
  }

  function fecErrorMessage(err) {
    if (err.message === "FEC_RATE_LIMIT") {
      return "FEC rate limit reached. Set window.FEC_API_KEY in config.js to a free api.data.gov key.";
    }
    if (err.name === "AbortError") return "The FEC API took too long to respond. Please try again.";
    return "Couldn't load candidates from the FEC API. Please try again.";
  }

  function showCandidatePopup(district, zipCode) {
    const seq = ++state.candidateSeq;
    if (state.candidateAbort) state.candidateAbort.abort();
    const controller = new AbortController();
    state.candidateAbort = controller;
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    els.candidateEyebrow.textContent = district.id;
    els.candidateTitle.textContent = district.label || district.id;

    const view = { incumbent: undefined, candidates: undefined };
    const render = () => {
      if (seq === state.candidateSeq) renderCandidateSections(district, zipCode, view);
    };
    render();

    if (!state.returnFocusTo) state.returnFocusTo = document.activeElement;
    els.candidateOverlay.hidden = false;
    document.body.classList.add("modal-open");
    els.candidateCloseBtn.focus();

    // Each source renders as soon as it settles, so one failing never blanks the other.
    const incumbentTask = fetchIncumbent(district).then(
      (rows) => { view.incumbent = { rows }; },
      (err) => {
        console.error(err);
        view.incumbent = { error: "Couldn't load the current representative. Please try again." };
      }
    ).then(render);

    const candidatesTask = fetchFecCandidates(district, controller.signal).then(
      (rows) => { view.candidates = { rows }; },
      (err) => {
        console.error(err);
        view.candidates = { error: fecErrorMessage(err) };
      }
    ).then(render);

    Promise.all([incumbentTask, candidatesTask]).then(() => {
      clearTimeout(timeoutId);
      if (state.candidateAbort === controller) state.candidateAbort = null;
    });
  }

  function closeCandidatePopup() {
    if (els.candidateOverlay.hidden) return;
    state.candidateSeq++;
    if (state.candidateAbort) state.candidateAbort.abort();
    els.candidateOverlay.hidden = true;
    document.body.classList.remove("modal-open");
    const target = state.returnFocusTo;
    state.returnFocusTo = null;
    (target && document.contains(target) ? target : els.input).focus();
  }

  // ---------- Map ----------

  function ensureMap() {
    if (map) return true;
    if (typeof L === "undefined") {
      els.mapEl.classList.add("map-unavailable");
      els.mapEl.replaceChildren(
        el("p", { text: "Map failed to load. Use the district list to choose." })
      );
      return false;
    }

    map = L.map(els.mapEl, { zoomControl: true, scrollWheelZoom: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    districtLayer = L.featureGroup().addTo(map);
    return true;
  }

  function renderDistrictLayers(entry) {
    districtLayer.clearLayers();
    polygonById.clear();

    entry.districts.forEach((district) => {
      if (!district.geometry) return;
      const poly = L.geoJSON(district.geometry, {
        style: {
          ...POLYGON_STYLE.base,
          color: district.color,
          fillColor: district.color,
        },
      });
      poly.bindTooltip(district.id, { sticky: true, direction: "top" });
      poly.on("click", () => chooseDistrict(district.id));
      poly.on("mouseover", () => setHover(district.id, true));
      poly.on("mouseout", () => setHover(district.id, false));
      poly.addTo(districtLayer);
      polygonById.set(district.id, poly);
    });

    zctaLayer = entry.zctaGeometry ? L.geoJSON(entry.zctaGeometry, { style: ZCTA_STYLE }).addTo(districtLayer) : null;

    if (entry.center) {
      L.circleMarker(entry.center, {
        radius: 5,
        color: "#111827",
        weight: 2,
        fillColor: "#ffffff",
        fillOpacity: 1,
        interactive: false,
      }).addTo(districtLayer);
    }
  }

  // Districts can be far larger than the ZIP (up to a whole state), so frame the ZIP itself.
  function fitToDistricts() {
    const zipBounds = zctaLayer && zctaLayer.getBounds();
    const bounds = zipBounds && zipBounds.isValid() ? zipBounds : districtLayer.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [24, 24] });
    } else if (state.entry && state.entry.center) {
      map.setView(state.entry.center, 13);
    }
  }

  function applyPolygonStyle(id) {
    const poly = polygonById.get(id);
    if (!poly) return;
    poly.setStyle(id === state.selectedId ? { ...POLYGON_STYLE.base, ...POLYGON_STYLE.selected } : POLYGON_STYLE.base);
  }

  // ---------- Map <-> sidebar sync ----------

  function setHover(id, isHovering) {
    const poly = polygonById.get(id);
    const btn = buttonById.get(id);
    if (btn) btn.classList.toggle("is-hovered", isHovering);
    if (!poly) return;
    if (isHovering && id !== state.selectedId) poly.setStyle(POLYGON_STYLE.hover);
    else applyPolygonStyle(id);
  }

  function findDistrict(id) {
    return state.entry && state.entry.districts.find((d) => d.id === id);
  }

  function chooseDistrict(id) {
    const district = findDistrict(id);
    if (district) resolveDistrict(state.zip, district);
  }

  function renderSidebar(entry) {
    buttonById.clear();
    const items = entry.districts.map((district) => {
      const btn = el(
        "button",
        {
          type: "button",
          className: "district-btn",
          "aria-pressed": "false",
          "data-id": district.id,
          onClick: () => chooseDistrict(district.id),
          onMouseenter: () => setHover(district.id, true),
          onMouseleave: () => setHover(district.id, false),
          onFocus: () => setHover(district.id, true),
          onBlur: () => setHover(district.id, false),
        },
        [
          el("span", { className: "swatch", style: { background: district.color }, "aria-hidden": "true" }),
          el("span", { className: "district-btn-text" }, [
            el("strong", { text: district.id }),
            el("span", { text: district.label }),
          ]),
        ]
      );
      buttonById.set(district.id, btn);
      return el("li", null, [btn]);
    });
    els.list.replaceChildren(...items);
  }

  // ---------- Modal ----------

  function openModal(zip, entry) {
    state.zip = zip;
    state.entry = entry;
    state.selectedId = null;
    if (els.overlay.hidden) state.returnFocusTo = document.activeElement;

    els.modalTitle.textContent = "ZIP " + zip + " spans " + entry.districts.length + " congressional districts";
    els.modalDesc.textContent = entry.place;
    els.status.textContent = "";
    renderSidebar(entry);

    els.overlay.hidden = false;
    document.body.classList.add("modal-open");

    const hasMap = ensureMap();
    if (hasMap) {
      renderDistrictLayers(entry);
      // Leaflet caches the container size, which was 0x0 while the modal was hidden.
      requestAnimationFrame(() => {
        map.invalidateSize();
        fitToDistricts();
      });
    }

    els.closeBtn.focus();
  }

  // Pass { restoreFocus: false } when handing off to the candidate popup, which then owns the return focus.
  function closeModal(options) {
    if (els.overlay.hidden) return;
    els.overlay.hidden = true;
    document.body.classList.remove("modal-open");
    if (options && options.restoreFocus === false) return;
    const target = state.returnFocusTo;
    state.returnFocusTo = null;
    if (target && document.contains(target)) target.focus();
  }

  function activeModal() {
    if (!els.candidateOverlay.hidden) return { modal: els.candidateModal, close: closeCandidatePopup };
    if (!els.overlay.hidden) return { modal: els.modal, close: closeModal };
    return null;
  }

  function getFocusable(modal) {
    return Array.from(
      modal.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).filter((node) => node.offsetParent !== null);
  }

  function handleModalKeydown(event) {
    const active = activeModal();
    if (!active) return;

    if (event.key === "Escape") {
      event.preventDefault();
      active.close();
      return;
    }

    if (event.key === "Tab") {
      const focusable = getFocusable(active.modal);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  // ---------- Wiring ----------

  els.input.addEventListener("input", () => {
    const digits = els.input.value.replace(/\D/g, "").slice(0, 5);
    if (digits !== els.input.value) els.input.value = digits;
    if (!els.error.hidden) clearError();
  });

  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    const zip = els.input.value.trim();
    const error = validateZip(zip);
    if (error) {
      showError(error);
      els.input.focus();
      return;
    }
    clearError();
    lookup(zip);
  });

  els.hint.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-zip]");
    if (!btn) return;
    els.input.value = btn.dataset.zip;
    clearError();
    lookup(btn.dataset.zip);
  });

  els.closeBtn.addEventListener("click", () => closeModal());
  els.cancelBtn.addEventListener("click", () => closeModal());
  els.overlay.addEventListener("click", (event) => {
    if (event.target === els.overlay) closeModal();
  });

  els.candidateCloseBtn.addEventListener("click", closeCandidatePopup);
  els.candidateDoneBtn.addEventListener("click", closeCandidatePopup);
  els.candidateOverlay.addEventListener("click", (event) => {
    if (event.target === els.candidateOverlay) closeCandidatePopup();
  });
  document.addEventListener("keydown", handleModalKeydown);

  window.addEventListener("resize", () => {
    if (map && !els.overlay.hidden) map.invalidateSize();
  });

  // Warm the cache so the current representative renders immediately once a district is chosen.
  loadRepresentatives().catch((err) => console.error(err));
})();
