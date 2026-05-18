/* Rep Lookup Widget — impeachpolis.org
 * Loaded via <script src="...rep-lookup.js"> in a WP Custom HTML block.
 * Reads data-api-key from <div id="rep-lookup-widget">.
 */
(function () {
  'use strict';

  const REPS_JSON_URL = 'https://cdn.jsdelivr.net/gh/gibrown/impeach-polis-widget@main/reps.json';
  const CIVIC_API_BASE = 'https://civicinfo.googleapis.com/civicinfo/v2/representatives';

  // ── Pure utilities ──────────────────────────────────────────────────────────

  function normalizeName(name) {
    return name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  }

  function stanceSortOrder(stance) {
    return { supportive: 0, maybe: 1, contacted: 2, unknown: 3, opposed: 4 }[stance] ?? 3;
  }

  /**
   * Find the entry in repsData that matches a Google Civic API official.
   * Matches by normalized name, preferring legislators for state roles.
   * Returns the matched rep object or null.
   */
  function matchOfficial(civicOfficial, repsData) {
    const normalizedTarget = normalizeName(civicOfficial.name);
    const officeName = (civicOfficial.officeName || '').toLowerCase();

    // Try legislators first for state-level roles
    const isStateLower = officeName.includes('house') || officeName.includes('representative') ||
                         officeName.includes('assembly');
    const isStateUpper = officeName.includes('senator') && !officeName.includes('united states') &&
                         !officeName.includes('u.s.');

    if (isStateLower || isStateUpper) {
      const targetChamber = isStateLower ? 'house' : 'senate';
      const match = repsData.legislators.find(
        l => l.chamber === targetChamber && normalizeName(l.name) === normalizedTarget
      );
      if (match) return match;
    }

    // Try officials
    const matchOffic = repsData.officials.find(
      o => normalizeName(o.name) === normalizedTarget
    );
    if (matchOffic) return matchOffic;

    // Fallback: search all legislators regardless of chamber
    return repsData.legislators.find(
      l => normalizeName(l.name) === normalizedTarget
    ) || null;
  }

  // ── Data loading ─────────────────────────────────────────────────────────────

  async function fetchRepsData(apiKey) {
    // In dev mode (localhost), load from local reps.json
    const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const url = isDev ? '/reps.json' : REPS_JSON_URL;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to load reps.json: ${resp.status}`);
    return resp.json();
  }

  // ── Google APIs ──────────────────────────────────────────────────────────────

  function loadGoogleMapsSDK(apiKey) {
    return new Promise((resolve, reject) => {
      if (window.google && window.google.maps && window.google.maps.places) {
        resolve();
        return;
      }
      const callbackName = '_rlGoogleMapsReady';
      window[callbackName] = resolve;
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places&callback=${callbackName}`;
      script.onerror = () => reject(new Error('Failed to load Google Maps SDK'));
      document.head.appendChild(script);
    });
  }

  async function callCivicAPI(address, apiKey) {
    const url = `${CIVIC_API_BASE}?address=${encodeURIComponent(address)}&key=${apiKey}&levels=country&levels=administrativeArea1`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error?.message || `Civic API error ${resp.status}`);
    }
    return resp.json();
  }

  /**
   * Parse Civic API response into a flat list of {name, officeName, level} objects.
   * The API returns offices[] and officials[], where offices[i].officialIndices lists
   * which officials hold each office.
   */
  function parseCivicResponse(data) {
    const results = [];
    const offices = data.offices || [];
    const officials = data.officials || [];
    for (const office of offices) {
      for (const idx of (office.officialIndices || [])) {
        const official = officials[idx];
        if (official) {
          results.push({
            name: official.name,
            officeName: office.name,
            levels: office.levels || [],
            roles: office.roles || [],
          });
        }
      }
    }
    return results;
  }

  /**
   * From the parsed Civic results, pick:
   * - houseRep: the state lower body rep
   * - senateRep: the state upper body rep
   * - federalPool: all country-level officials (for random selection)
   */
  function classifyCivicResults(civicOfficials) {
    let houseRep = null;
    let senateRep = null;
    const federalPool = [];

    for (const off of civicOfficials) {
      const roles = off.roles || [];
      const levels = off.levels || [];
      const officeName = (off.officeName || '').toLowerCase();

      if (roles.includes('legislatorLowerBody') ||
          (levels.includes('administrativeArea1') && officeName.includes('house'))) {
        houseRep = houseRep || off;
      } else if (roles.includes('legislatorUpperBody') ||
                 (levels.includes('administrativeArea1') && officeName.includes('senator'))) {
        senateRep = senateRep || off;
      } else if (levels.includes('country')) {
        federalPool.push(off);
      }
    }

    return { houseRep, senateRep, federalPool };
  }

  // ── Rendering helpers ─────────────────────────────────────────────────────────

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html) e.innerHTML = html;
    return e;
  }

  function escHtml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderStanceBadge(label, stance, secondary) {
    const cls = `rl-badge s-${stance}${secondary ? ' secondary' : ''}`;
    const labels = {
      supportive: `✓ Supports`,
      maybe: `~ Possibly Supports`,
      opposed: `✗ Opposed`,
      unknown: `? Unknown`,
      contacted: `? Contacted`,
    };
    const b = el('span', cls);
    b.textContent = `${labels[stance] || stance}${label ? ' ' + label : ''}`;
    return b;
  }

  function renderQuote(rep) {
    if (!rep.quote) return null;
    const div = el('div', `rl-quote q-${rep.special_session_stance}`);
    div.innerHTML = `"${escHtml(rep.quote)}"`;
    if (rep.quote_url) {
      const a = el('a');
      a.href = rep.quote_url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = '→ Source';
      div.appendChild(a);
    }
    return div;
  }

  function renderContactLinks(rep) {
    const div = el('div', 'rl-contact');
    if (rep.phone) {
      const a = el('a', 'phone');
      a.href = `tel:${rep.phone.replace(/\D/g, '')}`;
      a.textContent = `📞 ${rep.phone}`;
      div.appendChild(a);
    }
    if (rep.email) {
      const isUrl = rep.email.startsWith('http');
      const a = el('a', 'email');
      a.href = isUrl ? rep.email : `mailto:${rep.email}`;
      if (isUrl) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      a.textContent = `✉ ${isUrl ? 'Contact Form' : rep.email}`;
      div.appendChild(a);
    }
    if (rep.website && !rep.email) {
      const a = el('a', 'web');
      a.href = rep.website;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = '🌐 Website';
      div.appendChild(a);
    }
    return div.children.length ? div : null;
  }

  function renderChallengers(rep) {
    const challengers = rep.challengers || [];
    if (!challengers.length) return null;

    const section = el('div', 'rl-challengers');
    const isGovRace = (rep.election_note || '').toLowerCase().includes('governor');
    const labelText = isGovRace ? "Governor's Race Challengers" : "Primary Challengers";
    section.appendChild(el('div', 'rl-challengers-label', escHtml(labelText)));

    for (const ch of challengers) {
      const isSupporting = ch.special_session_stance === 'supportive';
      const isMaybe = ch.special_session_stance === 'maybe';
      const card = el('div', `rl-challenger${isSupporting ? ' supporting' : isMaybe ? ' maybe-supporting' : ''}`);

      if (isSupporting) {
        card.appendChild(el('div', 'rl-challenger-banner banner-supportive', '⭐ Supports Special Session'));
      } else if (isMaybe) {
        card.appendChild(el('div', 'rl-challenger-banner banner-maybe', '~ Possibly Supportive of Special Session'));
      }

      card.appendChild(el('div', 'rl-challenger-name', escHtml(ch.name)));

      const stancesDiv = el('div', 'rl-stances');
      stancesDiv.appendChild(renderStanceBadge('Special Session', ch.special_session_stance, true));
      stancesDiv.appendChild(renderStanceBadge('Impeachment', ch.impeachment_stance, true));
      card.appendChild(stancesDiv);

      if (ch.quote) card.appendChild(renderQuote(ch));

      const contactDiv = el('div', 'rl-contact');
      if (ch.email) {
        const a = el('a', 'email'); a.href = `mailto:${ch.email}`; a.textContent = `✉ ${ch.email}`; contactDiv.appendChild(a);
      }
      if (ch.website) {
        const a = el('a', 'web'); a.href = ch.website; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = '🌐 Website'; contactDiv.appendChild(a);
      }
      if (contactDiv.children.length) card.appendChild(contactDiv);

      section.appendChild(card);
    }
    return section;
  }

  function renderCard(roleLabel, rep) {
    const stance = rep.special_session_stance || 'unknown';
    const card = el('div', `rl-card stance-${stance}`);

    card.appendChild(el('div', 'rl-card-role', escHtml(roleLabel)));
    card.appendChild(el('div', 'rl-card-name', escHtml(rep.name)));

    const districtText = rep.chamber
      ? `${rep.chamber === 'house' ? 'HD' : 'SD'}-${String(rep.district).padStart(2, '0')} · ${(rep.party || '').charAt(0).toUpperCase() + (rep.party || '').slice(1)}`
      : `${escHtml(rep.title || '')} · ${(rep.party || '').charAt(0).toUpperCase() + (rep.party || '').slice(1)}`;
    card.appendChild(el('div', 'rl-card-district', districtText));

    const stancesDiv = el('div', 'rl-stances');
    if (rep.election_note) {
      stancesDiv.appendChild(renderStanceBadge(rep.election_note, 'election', false));
    }
    stancesDiv.appendChild(renderStanceBadge('Special Session', stance, false));
    stancesDiv.appendChild(renderStanceBadge('Impeachment', rep.impeachment_stance || 'unknown', true));
    card.appendChild(stancesDiv);

    if (stance === 'maybe') {
      card.appendChild(el('div', 'rl-maybe-note', '⚠ Encouraging statement — not yet confirmed. Call and ask directly.'));
    }
    if ((stance === 'unknown' || stance === 'contacted') && rep.outreach_count > 0) {
      card.appendChild(el('div', 'rl-outreach-note', `⚠ ${rep.outreach_count} constituent${rep.outreach_count !== 1 ? 's' : ''} have contacted ${escHtml(rep.name.split(' ')[0])} — no response yet`));
    }

    const contact = renderContactLinks(rep);
    if (contact) card.appendChild(contact);

    const quote = renderQuote(rep);
    if (quote) card.appendChild(quote);

    if (stance !== 'supportive') {
      const challengers = renderChallengers(rep);
      if (challengers) card.appendChild(challengers);
    }

    return card;
  }

  // ── Table rendering ──────────────────────────────────────────────────────────

  function renderTable(repsData) {
    const section = el('div', 'rl-table-section');
    section.appendChild(el('div', 'rl-table-title', 'Call Them All'));
    section.appendChild(el('div', 'rl-table-subtitle', 'Every Colorado state legislator. Call or email yours.'));

    const allReps = [
      ...repsData.legislators.filter(l => l.chamber === 'house').sort((a, b) => a.district - b.district),
      ...repsData.legislators.filter(l => l.chamber === 'senate').sort((a, b) => a.district - b.district),
      ...repsData.officials,
    ].sort((a, b) => stanceSortOrder(a.special_session_stance) - stanceSortOrder(b.special_session_stance));

    const table = el('table', 'rl-table');
    table.innerHTML = `<thead><tr>
      <th>Name</th>
      <th class="hide-mobile">District</th>
      <th>Phone</th>
      <th class="hide-mobile">Email</th>
      <th>Stance</th>
    </tr></thead>`;

    const tbody = document.createElement('tbody');
    for (const rep of allReps) {
      const tr = document.createElement('tr');
      const distStr = rep.chamber === 'house' ? `HD-${String(rep.district).padStart(2,'0')}`
                    : rep.chamber === 'senate' ? `SD-${String(rep.district).padStart(2,'0')}`
                    : (rep.title || '');
      tr.innerHTML = `
        <td>${escHtml(rep.name)}</td>
        <td class="hide-mobile">${escHtml(distStr)}</td>
        <td class="phone-cell">${rep.phone ? `<a href="tel:${rep.phone.replace(/\D/g,'')}">${escHtml(rep.phone)}</a>` : '—'}</td>
        <td class="email-cell hide-mobile">${rep.email ? `<a href="mailto:${rep.email}">${escHtml(rep.email)}</a>` : '—'}</td>
        <td class="stance-cell"></td>
      `;
      const stanceCell = tr.querySelector('.stance-cell');
      stanceCell.appendChild(renderStanceBadge('', rep.special_session_stance, true));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    section.appendChild(table);
    return section;
  }

  // ── Main widget init ──────────────────────────────────────────────────────────

  async function buildWidget(container, apiKey) {
    let repsData;

    try {
      repsData = await fetchRepsData(apiKey);
    } catch (e) {
      container.appendChild(el('div', 'rl-error', `Could not load representative data: ${escHtml(e.message)}`));
      return;
    }

    try {
      await loadGoogleMapsSDK(apiKey);
    } catch (e) {
      container.appendChild(el('div', 'rl-error', 'Could not load Google Maps. Check your API key and network connection.'));
      return;
    }

    // ── Search UI ──
    const searchSection = el('div', 'rl-search');

    const addressRow = el('div', 'rl-address-row');
    const addressInput = el('input', 'rl-address-input');
    addressInput.type = 'text';
    addressInput.placeholder = 'Enter your Colorado address…';
    addressInput.autocomplete = 'street-address';

    const searchBtn = el('button', 'rl-btn rl-btn-search');
    searchBtn.textContent = 'Find My Reps';
    addressRow.appendChild(addressInput);
    addressRow.appendChild(searchBtn);

    const divider = el('div', 'rl-divider', '— or —');

    const locationBtn = el('button', 'rl-btn rl-btn-location');
    locationBtn.textContent = '📍 Use My Location';

    const errorDiv = el('div', 'rl-error');
    errorDiv.style.display = 'none';

    searchSection.appendChild(addressRow);
    searchSection.appendChild(divider);
    searchSection.appendChild(locationBtn);
    searchSection.appendChild(errorDiv);
    container.appendChild(searchSection);

    // Init Google Places Autocomplete restricted to US addresses
    const autocomplete = new window.google.maps.places.Autocomplete(addressInput, {
      types: ['address'],
      componentRestrictions: { country: 'us' },
    });

    // ── Results container ──
    const resultsDiv = el('div', 'rl-results');
    container.appendChild(resultsDiv);

    // ── Table (always shown) ──
    container.appendChild(renderTable(repsData));

    // ── Lookup handler ──
    function showError(msg) {
      errorDiv.textContent = msg;
      errorDiv.style.display = '';
    }
    function clearError() { errorDiv.style.display = 'none'; }

    async function doLookup(address) {
      clearError();
      resultsDiv.innerHTML = '<div class="rl-spinner">Looking up your representatives…</div>';
      searchBtn.disabled = true;
      locationBtn.disabled = true;

      let civicData;
      try {
        civicData = await callCivicAPI(address, apiKey);
      } catch (e) {
        resultsDiv.innerHTML = '';
        showError(`Could not look up representatives: ${e.message}`);
        searchBtn.disabled = false;
        locationBtn.disabled = false;
        return;
      }

      const civicOfficials = parseCivicResponse(civicData);
      const { houseRep, senateRep, federalPool } = classifyCivicResults(civicOfficials);

      resultsDiv.innerHTML = '';

      function renderLookupCard(roleLabel, civicOff) {
        if (!civicOff) return;
        const rep = matchOfficial(civicOff, repsData);
        if (rep) {
          resultsDiv.appendChild(renderCard(roleLabel, rep));
        } else {
          const card = el('div', 'rl-card');
          card.appendChild(el('div', 'rl-card-role', escHtml(roleLabel)));
          card.appendChild(el('div', 'rl-card-name', escHtml(civicOff.name)));
          card.appendChild(el('div', 'rl-card-district', escHtml(civicOff.officeName)));
          resultsDiv.appendChild(card);
        }
      }

      renderLookupCard('Your State House Rep', houseRep);
      renderLookupCard('Your State Senator', senateRep);

      // Random federal/statewide card from our officials pool
      if (repsData.officials.length > 0) {
        const randomOff = repsData.officials[Math.floor(Math.random() * repsData.officials.length)];
        resultsDiv.appendChild(renderCard('Also Representing You', randomOff));
      }

      searchBtn.disabled = false;
      locationBtn.disabled = false;
    }

    // Address form submit
    searchBtn.addEventListener('click', () => {
      const addr = addressInput.value.trim();
      if (!addr) { showError('Please enter an address.'); return; }
      doLookup(addr);
    });
    addressInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { searchBtn.click(); }
    });

    // Places autocomplete selection
    autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace();
      if (place && place.formatted_address) {
        doLookup(place.formatted_address);
      }
    });

    // Geolocation button
    locationBtn.addEventListener('click', () => {
      if (!navigator.geolocation) {
        showError('Geolocation is not supported by your browser.');
        return;
      }
      locationBtn.disabled = true;
      locationBtn.textContent = '📍 Getting location…';
      navigator.geolocation.getCurrentPosition(
        pos => {
          locationBtn.textContent = '📍 Use My Location';
          doLookup(`${pos.coords.latitude},${pos.coords.longitude}`);
        },
        () => {
          locationBtn.disabled = false;
          locationBtn.textContent = '📍 Use My Location';
          showError('Could not get your location. Please enter your address instead.');
        }
      );
    });
  }

  // ── Entry point ───────────────────────────────────────────────────────────────

  function init() {
    const container = document.getElementById('rep-lookup-widget');
    if (!container) return;
    const apiKey = container.dataset.apiKey;
    if (!apiKey) {
      container.textContent = 'Widget error: missing data-api-key attribute.';
      return;
    }
    buildWidget(container, apiKey);
  }

  // Export pure functions for Node.js testing (must come before DOM access)
  if (typeof module !== 'undefined') {
    module.exports = { normalizeName, matchOfficial, stanceSortOrder };
    return;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
