/* Houtbeheer custom Lovelace card — lokaal, zonder externe bibliotheken.
Installatie: kopieer naar /config/www/houtbeheer-card.js en voeg resource
/local/houtbeheer-card.js toe als JavaScript-module.
Kaart YAML: type: custom:houtbeheer-card
Optioneel: title: Houtbeheer
Optioneel: aantal_hokken: 12
Optioneel: verloop: true (grafiek van de laatste metingen van het gekozen hok)
Optioneel: kolommen: auto (of 1 t/m 8), weergave: uitgebreid | compact,
           tegelinhoud: [houtsoorten, vocht, status, laatste_meting, vuldatum, actief]
Optioneel expliciete koppeling (als entiteiten hernoemd zijn):
hokken:
  - nummer: 1
    houtsoort: sensor.houthok_1_houtsoorten
    invoer: number.houthok_1_nieuwe_vochtmeting
    opslaan: button.houthok_1_meting_opslaan
    vocht: sensor.houthok_1_opgeslagen_vochtgehalte
    datum: sensor.houthok_1_laatste_meting
    vuldatum: date.houthok_1_vuldatum              (optioneel)
    actief: switch.houthok_1_actief_hok            (optioneel)
    reset: button.houthok_1_reset_hok              (optioneel)
    stookklaar: binary_sensor.houthok_1_stookklaar (optioneel; anders rekent de kaart zelf met 20%)
De stookklaar-grens is instelbaar in de opties van de integratie (1.9.0); de kaart leest ze uit het attribuut grens.
*/
class HoutbeheerCard extends HTMLElement {
  constructor() {
    super(); this.attachShadow({mode:'open'}); this.selected = null;
    this.drafts = {}; this.busy = false; this.message = ''; this.error = false;
    this._dirty = false; this._watched = []; this._shedCache = null;
    this.pendingWood = {}; this.woodOpen = false;
  }
  setConfig(config) {
    this.config = {title:'Houtbeheer', ...config}; this.render();
  }
  set hass(hass) {
    const previous = this._hass;
    this._hass = hass;
    if (!this.config) return;
    // HA stuurt bij elke state-change in huis een nieuwe hass; teken alleen opnieuw als er iets relevants veranderd is.
    if (this._dirty || !previous || this.changed(previous, hass)) this.render();
  }
  changed(previous, hass) {
    if (previous.entities !== hass.entities || previous.devices !== hass.devices) return true;
    if (!this._watched.length) return true;
    return this._watched.some(id => previous.states[id] !== hass.states[id]);
  }
  getCardSize() { return 7; }
  normalize(s) { return String(s || '').toLowerCase().replace(/[_\s]+/g,' ').trim(); }
  find(number, domain, suffix) {
    const expected = this.normalize(`Houthok ${number} ${suffix}`);
    const fallback = `${domain}.houthok_${number}_${suffix.toLowerCase().replaceAll(' ','_')}`;
    if (this._hass.states[fallback]) return fallback;
    return Object.keys(this._hass.states).find(id => id.startsWith(domain+'.') &&
      this.normalize(this._hass.states[id].attributes.friendly_name) === expected);
  }
  sheds() {
    if (!this._hass) return [];
    // Het ontdekken loopt over alle states in HA: bewaar het resultaat zolang register, apparaten, config en aantal states gelijk blijven.
    const count = Object.keys(this._hass.states).length;
    const cache = this._shedCache;
    if (cache && cache.entities === this._hass.entities && cache.devices === this._hass.devices
        && cache.config === this.config && cache.count === count) return cache.value;
    const value = this.discover();
    this._shedCache = {entities:this._hass.entities, devices:this._hass.devices, config:this.config, count, value};
    return value;
  }
  discover() {
    if (this.config.hokken) return this.config.hokken;
    const groups = new Map();
    for (const [id, state] of Object.entries(this._hass.states)) {
      const a = state.attributes;
      if (!a.houtbeheer_id || !a.houtbeheer_rol) continue;
      if (!groups.has(a.houtbeheer_id)) groups.set(a.houtbeheer_id, {nummer:Number(a.houtbeheer_hok)});
      const shed = groups.get(a.houtbeheer_id);
      shed[a.houtbeheer_rol] = id;
      const registry = this._hass.entities?.[id];
      const device = registry && this._hass.devices?.[registry.device_id];
      if (device) shed.naam = device.name_by_user || device.name;
    }
    if (groups.size) return [...groups.values()].filter(s=>s.opslaan).sort((a,b)=>a.nummer-b.nummer);
    const numbers = new Set();
    for (const [id,state] of Object.entries(this._hass.states)) {
      if (!id.startsWith('button.')) continue;
      const match = this.normalize(state.attributes.friendly_name).match(/^houthok (\d+) meting opslaan$/)
        || id.match(/^button\.houthok_(\d+)_meting_opslaan(?:_\d+)?$/);
      if (match) numbers.add(Number(match[1]));
    }
    if (this.config.aantal_hokken) {
      for(let n=1;n<=this.config.aantal_hokken;n++) numbers.add(n);
    }
    return [...numbers].sort((a,b)=>a-b).map(n=>({nummer:n,
      houtsoort:this.find(n,'sensor','Houtsoorten')||this.find(n,'select','Houtsoort'),
      invoer:this.find(n,'number','Nieuwe vochtmeting'),
      opslaan:this.find(n,'button','Meting opslaan'),
      vocht:this.find(n,'sensor','Opgeslagen vochtgehalte'),
      datum:this.find(n,'sensor','Laatste meting'),
      vuldatum:this.find(n,'date','Vuldatum')}));
  }
  escape(value) { return String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  state(id) { return this._hass?.states[id]; }
  valid(value) { return value !== undefined && value !== null && !['unknown','unavailable',''].includes(value); }
  threshold(shed) {
    // De grens is instelbaar in de opties van de integratie (1.9.0) en staat als attribuut op de stookklaar-sensor.
    const value = Number(this.state(shed.stookklaar)?.attributes?.grens);
    return Number.isFinite(value) ? value : 20;
  }
  isReady(shed, moisture, valid) {
    // Voorkeur: de stookklaar-binary sensor van de integratie, zodat de drempel op één plek staat.
    const sensor = this.state(shed.stookklaar)?.state;
    if (sensor === 'on' || sensor === 'off') return sensor === 'on';
    return valid && Number(moisture) < this.threshold(shed); // terugval bij een handmatige koppeling zonder stookklaar-entiteit
  }
  woodTypes(shed) {
    // De lijst staat in het attribuut houtsoorten van de sensor. Zolang een keuze onderweg is gebruiken we die,
    // zodat snel na elkaar aanvinken niets overschrijft; zodra HA dezelfde lijst meldt, vervalt ze.
    const state = this.state(shed.houtsoort);
    const attr = state?.attributes?.houtsoorten;
    const actual = Array.isArray(attr) ? attr
      : (this.valid(state?.state) && state.state !== 'Geen houtsoort' ? [state.state] : []);
    const pending = this.pendingWood[shed.nummer];
    if (pending) {
      if (pending.length === actual.length && pending.every(wood => actual.includes(wood))) delete this.pendingWood[shed.nummer];
      else return pending;
    }
    return actual;
  }
  woodOptions(shed) {
    const attrs = this.state(shed.houtsoort)?.attributes || {};
    return attrs.opties ?? attrs.options ?? [];
  }
  columns() {
    const n = Number(this.config.kolommen);
    return Number.isInteger(n) && n >= 1 && n <= 8 ? n : null; // null = automatisch
  }
  tileItems() {
    const all = ['houtsoorten','vocht','status','laatste_meting','vuldatum','actief'];
    if (Array.isArray(this.config.tegelinhoud)) return all.filter(k => this.config.tegelinhoud.includes(k));
    return this.config.weergave === 'compact' ? ['vocht','actief'] : ['houtsoorten','vocht','status','actief'];
  }
  shortDate(value, withTime) {
    if (!this.valid(value)) return '';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + 'T00:00:00') : new Date(value);
    return isNaN(date.getTime()) ? '' : date.toLocaleDateString('nl-BE', {day:'2-digit', month:'2-digit'});
  }
  filledLabel(value) {
    const short = this.shortDate(value);
    if (!short) return '';
    const days = Math.floor((Date.now() - new Date(value + 'T00:00:00').getTime()) / 864e5);
    return days >= 0 ? `Gevuld ${short} · ${days} d` : `Gevuld ${short}`;
  }
  num(value) { return String(value).replace('.', ','); }
  history(shed) {
    const list = this.state(shed.vocht)?.attributes?.metingen;
    if (!Array.isArray(list)) return [];
    return list.map(item => ({time: new Date(item.datum).getTime(), value: Number(item.vocht)}))
      .filter(item => !isNaN(item.time) && Number.isFinite(item.value)).sort((a, b) => a.time - b.time);
  }
  historyHtml(shed) {
    const points = this.history(shed);
    if (!points.length) return '';
    const e = v => this.escape(v), short = t => new Date(t).toLocaleDateString('nl-BE', {day: '2-digit', month: '2-digit', year: '2-digit'});
    const W = 300, H = 90, L = 34, R = 10, T = 10, B = 14;
    const min = Math.min(...points.map(p => p.value)), max = Math.max(...points.map(p => p.value));
    const lo = Math.floor(min - 1), hi = Math.ceil(max + 1);
    const t0 = points[0].time, t1 = points[points.length - 1].time;
    const x = p => t1 === t0 ? (L + W - R) / 2 : L + (p.time - t0) / (t1 - t0) * (W - L - R);
    const y = p => T + (hi - p.value) / (hi - lo) * (H - T - B);
    const line = points.length > 1 ? `<polyline points="${points.map(p => `${x(p).toFixed(1)},${y(p).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--primary-color)" stroke-width="2"/>` : '';
    const dots = points.map(p => `<circle cx="${x(p).toFixed(1)}" cy="${y(p).toFixed(1)}" r="3.5" fill="var(--primary-color)"><title>${e(short(p.time))}: ${e(this.num(p.value))}%</title></circle>`).join('');
    const axis = `<text x="2" y="${T + 4}" class="axis">${hi}%</text><text x="2" y="${H - B}" class="axis">${lo}%</text><line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" stroke="var(--divider-color)"/><line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="var(--divider-color)"/>`;
    let trend = '';
    if (points.length > 1) {
      const diff = Math.round((points[points.length - 1].value - points[0].value) * 10) / 10;
      trend = `<div class="trend">${diff === 0 ? 'Onveranderd' : `${diff < 0 ? '−' : '+'}${this.num(Math.abs(diff))} punten`} sinds ${e(short(t0))}</div>`;
    }
    const rows = [...points].reverse().map(p => `<li><span>${e(short(p.time))}</span><strong>${e(this.num(p.value))}%</strong></li>`).join('');
    return `<div class="history"><div class="history-title">Verloop · laatste ${points.length} ${points.length === 1 ? 'meting' : 'metingen'}</div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Verloop van het vochtpercentage" preserveAspectRatio="xMidYMid meet">${axis}${line}${dots}</svg>${trend}<ul>${rows}</ul></div>`;
  }
  woodLabel(types) {
    if (!types.length) return 'Geen houtsoort';
    return types.length <= 2 ? types.join(', ') : `${types.slice(0, 2).join(', ')} +${types.length - 2}`;
  }
  date(id) {
    const value=this.state(id)?.state;
    if(!this.valid(value)) return 'Nog niet gemeten';
    const date=new Date(value);
    return isNaN(date.getTime()) ? 'Geen meetdatum' : date.toLocaleString('nl-BE',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
  }
  render() {
    if (!this.config || !this._hass) return;
    // Niet hertekenen tijdens typen of opslaan: behoud focus en lokale invoer. Vinkjes tellen niet mee;
    // hun focus zetten we na het hertekenen terug (zie onderaan).
    // Onthoud dat er nog iets te tekenen valt; de eerstvolgende hass-update haalt dat in.
    const active = this.shadowRoot.activeElement;
    const typing = active && ['INPUT', 'SELECT'].includes(active.tagName) && active.type !== 'checkbox';
    if (this.busy || typing) { this._dirty = true; return; }
    const focusedWood = active?.matches?.('#wood-panel input') ? active.value : null;
    this._dirty = false;
    const sheds=this.sheds();
    this._watched = sheds.flatMap(s => ['houtsoort','invoer','opslaan','vocht','datum','vuldatum','actief','reset','stookklaar'].map(key => s[key]).filter(Boolean));
    if (!sheds.some(s=>s.nummer===this.selected)) this.selected=sheds[0]?.nummer;
    const shed=sheds.find(s=>s.nummer===this.selected);
    const e=v=>this.escape(v);
    const woodOptions=shed?this.woodOptions(shed):[];
    const woodChosen=shed?this.woodTypes(shed):[];
    const woodPanel=this.woodOpen&&woodOptions.length?`<div class="fields wood-fields"><div id="wood-panel" class="wood-panel" role="group" aria-label="Houtsoorten">${woodOptions.map(option=>`<label class="opt"><input type="checkbox" value="${e(option)}" ${woodChosen.includes(option)?'checked':''}>${e(option)}</label>`).join('')}</div></div>`:'';
    const compact=this.config.weergave==='compact';const cols=this.columns();const items=this.tileItems();const has=key=>items.includes(key);
    const draft=shed ? this.drafts[shed.nummer] ?? '' : '';
    this.shadowRoot.innerHTML=`
      <style>
        :host{display:block}ha-card{overflow:hidden;padding:20px;color:var(--primary-text-color);background:var(--ha-card-background,var(--card-background-color));border-radius:var(--ha-card-border-radius,16px)}
        h2{font-size:22px;margin:0 0 5px}p{color:var(--secondary-text-color);margin:0 0 18px;font-size:14px}
        .grid{display:grid;grid-template-columns:var(--cols);gap:8px;margin-bottom:22px}.compact .hok{padding:10px 4px;gap:2px}.compact .hok strong{font-size:14px}.compact .hok small{font-size:18px;font-weight:700;color:var(--primary-text-color)}.compact .hok.ready small{color:var(--success-color,#368647)}.history{margin:4px 0 16px}.history-title{font-size:14px;font-weight:600;margin-bottom:6px}.history svg{width:100%;height:auto;max-height:140px;display:block}.axis{font-size:9px;fill:var(--secondary-text-color)}.trend{font-size:13px;color:var(--secondary-text-color);margin:4px 0}.history ul{list-style:none;margin:6px 0 0;padding:0;font-size:14px;color:var(--secondary-text-color)}.history li{display:flex;justify-content:space-between;padding:2px 0}.history li strong{color:var(--primary-text-color)}.tile-date{font-size:11px;color:var(--secondary-text-color)}
        button,select,input{font:inherit;box-sizing:border-box}button{cursor:pointer;border:1px solid var(--divider-color);border-radius:10px;padding:10px;background:transparent;color:inherit}
        .hok{display:flex;flex-direction:column;gap:5px}.hok small{font-size:12px;color:var(--secondary-text-color)}.hok.active{border:2px solid var(--primary-color);background:var(--secondary-background-color)}
        .hok{padding:12px 5px;align-items:center;min-width:0}.wood-type{font-size:13px;overflow-wrap:anywhere}.hok.ready{background:rgba(54,134,71,.14);border-color:var(--success-color,#368647)}.hok.ready.active{border-color:var(--primary-color);box-shadow:inset 0 0 0 1px var(--primary-color)}.ready small{color:var(--success-color,#368647)}.status{display:block;border-radius:7px;padding:5px 4px;font-size:11px;font-weight:700;line-height:1.4;width:100%;box-sizing:border-box}.status-ready{background:var(--success-color,#368647);color:white}.status-wet{background:rgba(230,153,0,.15);color:var(--primary-text-color)}.status-unknown{background:var(--secondary-background-color);color:var(--secondary-text-color)}label{display:block;font-size:14px;margin-bottom:7px}select,input{width:100%;padding:12px;border:1px solid var(--divider-color);border-radius:10px;background:var(--secondary-background-color);color:inherit;min-height:46px}
        .fields{display:grid;grid-template-columns:1fr 1fr;gap:14px}.info{margin:16px 0;font-size:14px;line-height:1.7;color:var(--secondary-text-color)}.save{width:100%;background:var(--primary-color);color:var(--text-primary-color,#fff);border:0;font-weight:600;padding:14px}
        button:disabled,select:disabled,input:disabled{opacity:.5;cursor:default}.message{margin-top:12px;font-size:14px;color:var(--success-color,#368647)}.error{color:var(--error-color,#db4437)}
        .hok.take-wood{outline:3px solid #d99000;outline-offset:1px}.take-badge{background:#ffcf64;color:#342300;font-size:12px;font-weight:800;padding:7px 3px;border-radius:7px;width:100%;box-sizing:border-box}.permission{width:100%;margin:12px 0;font-weight:600}.permission.enabled{background:#ffcf64;color:#342300}.permission-note{font-size:13px;color:var(--secondary-text-color);margin-bottom:12px}
        .select-like{width:100%;display:flex;justify-content:space-between;align-items:center;gap:8px;text-align:left;padding:12px;min-height:46px;background:var(--secondary-background-color)}.select-like span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .wood-fields{grid-template-columns:1fr;margin-top:14px}.wood-panel{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:2px 10px;border:1px solid var(--divider-color);border-radius:10px;padding:6px 8px;background:var(--secondary-background-color)}.wood-panel .opt{display:flex;align-items:center;gap:10px;margin:0;padding:9px 4px;cursor:pointer}.wood-panel input[type=checkbox]{width:20px;height:20px;min-height:0;padding:0;margin:0;flex:none;accent-color:var(--primary-color)}
        @media(max-width:380px){.fields{grid-template-columns:1fr}}
      </style>
      <ha-card><h2>${e(this.config.title)}</h2>
      ${!shed ? '<p>Geen houthokken gevonden. Controleer de integratie of geef de entiteiten op in de kaartconfiguratie.</p>' : `
      <div class="grid ${compact?'compact':''}" style="--cols:${cols?`repeat(${cols},minmax(0,1fr))`:`repeat(auto-fill,minmax(${compact?'84px':'112px'},1fr))`}">${sheds.map(s=>{
        const moisture=this.state(s.vocht)?.state;const valid=this.valid(moisture);
        const ready=this.isReady(s,moisture,valid);
        const woodTypes=this.woodTypes(s);
        const allowed=this.state(s.actief)?.state==='on';
        const lastDate=has('laatste_meting')?this.shortDate(this.state(s.datum)?.state):'';
        const filled=has('vuldatum')?this.filledLabel(this.state(s.vuldatum)?.state):'';
        return `<button class="hok ${s.nummer===this.selected?'active':''} ${ready?'ready':''} ${allowed&&has('actief')?'take-wood':''}" data-hok="${e(s.nummer)}"><strong>${e(s.naam || `Hok ${s.nummer}`)}</strong>${has('houtsoorten')?`<span class="wood-type" title="${e(woodTypes.join(', '))}">${e(this.woodLabel(woodTypes))}</span>`:''}${has('vocht')?`<small>${valid?e(this.num(moisture))+'%':'Geen meting'}</small>`:''}${lastDate?`<span class="tile-date">Gemeten ${e(lastDate)}</span>`:''}${filled?`<span class="tile-date">${e(filled)}</span>`:''}${has('status')?`<span class="status ${ready?'status-ready':valid?'status-wet':'status-unknown'}">${ready?'🔥 Stookklaar':valid?'💧 Nog drogen':'— Niet gemeten'}</span>`:''}${allowed&&has('actief')?'<span class="take-badge">🪵 Neem hier hout</span>':''}</button>`;
      }).join('')}</div>
      <div class="fields"><div><label for="wood-toggle">Houtsoorten · Hok ${e(shed.nummer)}</label><button type="button" id="wood-toggle" class="select-like" aria-expanded="${woodPanel?'true':'false'}" aria-controls="wood-panel" title="${woodOptions.length?e(woodChosen.join(', ')):'Geen houtsoorten gevonden: werk de integratie bij naar 1.5.0'}" ${woodOptions.length?'':'disabled'}><span>${e(this.woodLabel(woodChosen))}</span><span aria-hidden="true">${woodPanel?'▴':'▾'}</span></button></div>
      <div><label for="moisture">Nieuwe vochtmeting (%)</label><input id="moisture" type="text" inputmode="decimal" placeholder="Bijvoorbeeld 18,5" value="${e(draft)}" ${this.state(shed.invoer)?'':'disabled'}></div></div>
      ${woodPanel}
      <div class="fields"><div><label for="filled-date">Hok gevuld op</label><input id="filled-date" type="date" value="${e(this.valid(this.state(shed.vuldatum)?.state)?this.state(shed.vuldatum).state:'')}" ${this.state(shed.vuldatum)&&this.state(shed.vuldatum).state!=='unavailable'?'':'disabled'}></div></div>
      <div class="info">Gevuld op: ${e(this.valid(this.state(shed.vuldatum)?.state)?this.state(shed.vuldatum).state.split('-').reverse().join('/'):'Nog niet ingesteld')}<br>Opgeslagen: <strong>${this.valid(this.state(shed.vocht)?.state)?e(this.num(this.state(shed.vocht).state))+'%':'Nog geen meting'}</strong><br>Laatste meting: ${e(this.date(shed.datum))}<br>Stookklaar onder: ${e(this.num(this.threshold(shed)))}%</div>
      ${this.config.verloop===false?'':this.historyHtml(shed)}
      <button class="save" id="save" ${this.state(shed.opslaan)&&this.state(shed.invoer)?'':'disabled'}>Meting opslaan · Hok ${e(shed.nummer)}</button>
      <div class="message ${this.error?'error':''}" role="status">${e(this.message)}</div>`}</ha-card>`;
    if(this.config.read_only) {
      this.shadowRoot.querySelectorAll('.fields').forEach(el=>el.remove());
      this.shadowRoot.querySelector('#save')?.remove();
      this.shadowRoot.querySelector('.message')?.remove();
    }
    this.shadowRoot.querySelectorAll('[data-hok]').forEach(button=>button.onclick=()=>{
      this.selected=Number(button.dataset.hok);this.message='';this.render();
    });
    const input=this.shadowRoot.querySelector('#moisture');
    if(input){input.oninput=()=>{this.drafts[shed.nummer]=input.value;};input.onkeydown=event=>{if(event.key==='Enter'){input.blur();this.save(shed);}};}
    const woodToggle=this.shadowRoot.querySelector('#wood-toggle');
    if(woodToggle) woodToggle.onclick=()=>{this.woodOpen=!this.woodOpen;this.render();};
    this.shadowRoot.querySelectorAll('#wood-panel input').forEach(box=>box.onchange=async()=>{
      // Lees de hele selectie uit de vinkjes, zodat snel na elkaar aanvinken niets overschrijft.
      const selection=[...this.shadowRoot.querySelectorAll('#wood-panel input:checked')].map(item=>item.value);
      this.pendingWood[shed.nummer]=selection;
      try{await this._hass.callService('houtbeheer','set_wood_types',{shed:shed.nummer,wood_types:selection});}
      catch(error){delete this.pendingWood[shed.nummer];this.message=error.message||'Houtsoorten wijzigen mislukt.';this.error=true;this.render();}
    });
    if(shed && shed.actief && !this.config.read_only) {
      const enabled=this.state(shed.actief)?.state==='on';
      const toggle=document.createElement('button');
      toggle.className=`permission ${enabled?'enabled':''}`;
      toggle.textContent=enabled?'🪵 Actief hok — hout nemen toegestaan':'Dit hok actief maken';
      toggle.setAttribute('aria-pressed',String(enabled));
      toggle.onclick=async()=>{
        toggle.disabled=true;
        try {
          await this._hass.callService('switch',enabled?'turn_off':'turn_on',{entity_id:shed.actief});
        } catch(error) {
          this.error=true;this.message=error.message||'Actieve status wijzigen mislukt.';
        } finally {toggle.disabled=false;this.render();}
      };
      this.shadowRoot.querySelector('.info')?.before(toggle);
      const note=document.createElement('div');note.className='permission-note';
      note.textContent='Handmatige toestemming om hout te nemen; onafhankelijk van het vochtpercentage. Meerdere hokken kunnen actief zijn.';
      toggle.after(note);
    }
    if(shed && shed.reset && !this.config.read_only) {
      const reset=document.createElement('button');
      reset.textContent='Reset hok';
      reset.style.cssText='width:100%;margin-top:12px;color:var(--error-color,#db4437)';
      reset.onclick=async()=>{
        if(this.busy)return;
        const name=shed.naam || `Hok ${shed.nummer}`;
        if(!window.confirm(`${name} resetten? De houtsoorten, nieuwe invoer, opgeslagen meting, meetgeschiedenis, meetdatum en vuldatum worden gewist. Het hok wordt niet-actief. Dit kan niet ongedaan worden gemaakt.`))return;
        this.shadowRoot.querySelector('input')?.blur();
        this.busy=true;
        this.shadowRoot.querySelectorAll('button,input,select').forEach(el=>el.disabled=true);
        reset.textContent='Hok resetten…';
        try {
          await this._hass.callService('button','press',{entity_id:shed.reset});
          delete this.drafts[shed.nummer];delete this.pendingWood[shed.nummer];
          this.error=false;this.message=`${name} is gereset.`;
        } catch(error) {
          this.error=true;this.message=error.message||'Resetten mislukt.';
        } finally {this.busy=false;this.render();}
      };
      this.shadowRoot.querySelector('#save')?.after(reset);
    }
    const filled=this.shadowRoot.querySelector('#filled-date');
    if(filled) filled.onchange=async()=>{
      if(this.busy)return;
      if(!filled.value){filled.value=this.valid(this.state(shed.vuldatum)?.state)?this.state(shed.vuldatum).state:'';return;}
      const value=filled.value;filled.blur();this.busy=true;filled.disabled=true;
      try {
        await this._hass.callService('date','set_value',{entity_id:shed.vuldatum,date:value});
        this.error=false;this.message='Vuldatum opgeslagen.';
      } catch(error) {
        this.error=true;this.message=error.message||'Vuldatum opslaan mislukt.';
      } finally {this.busy=false;this.render();}
    };
    const save=this.shadowRoot.querySelector('#save');if(save) save.onclick=()=>this.save(shed);
    if(focusedWood) [...this.shadowRoot.querySelectorAll('#wood-panel input')].find(box=>box.value===focusedWood)?.focus();
  }
  async save(shed) {
    if(this.busy) return;
    const text=String(this.drafts[shed.nummer]??'').trim().replace(',','.');
    const value=Number(text);const attrs=this.state(shed.invoer)?.attributes || {};
    const min=attrs.min??0,max=attrs.max??100;
    if(!text||!Number.isFinite(value)||value<min||value>max){
      this.shadowRoot.querySelector('input')?.blur();this.error=true;
      this.message=`Geef een vochtpercentage tussen ${min} en ${max} in.`;this.render();return;
    }
    this.shadowRoot.querySelector('input')?.blur();this.busy=true;
    this.shadowRoot.querySelectorAll('button,input,select').forEach(el=>el.disabled=true);
    const button=this.shadowRoot.querySelector('#save');if(button)button.textContent='Opslaan…';
    try {
      await this._hass.callService('number','set_value',{entity_id:shed.invoer,value});
      await this._hass.callService('button','press',{entity_id:shed.opslaan});
      delete this.drafts[shed.nummer];this.error=false;
      this.message=`Meting voor Hok ${shed.nummer} opgeslagen (${this.num(value)}%).`;
    } catch(error) {this.error=true;this.message=error.message||'Opslaan mislukt. Je invoer is behouden.';}
    finally {this.busy=false;this.render();}
  }
  static getConfigElement() { return document.createElement('houtbeheer-card-editor'); }
  static getStubConfig() {return {type:'custom:houtbeheer-card',title:'Houtbeheer',read_only:false};}
}
class HoutbeheerCardEditor extends HTMLElement {
  constructor() { super(); this.attachShadow({mode:'open'}); }
  // HA roept setConfig opnieuw aan na elk config-changed. Het formulier opnieuw opbouwen zou de focus
  // (en de cursor in het titelveld) bij elke toetsaanslag wegnemen; daarom bouwen we het één keer op.
  setConfig(config) { this.config={...config}; if(!this._built) this.build(); this.sync(); }
  set hass(hass) { this._hass=hass; }
  commit(config) {
    this.config=config;
    this.dispatchEvent(new CustomEvent('config-changed',{detail:{config},bubbles:true,composed:true}));
  }
  update(key,value) { this.commit({...this.config,[key]:value}); }
  items() {
    if(Array.isArray(this.config.tegelinhoud)) return this.config.tegelinhoud;
    return this.config.weergave==='compact'?['vocht','actief']:['houtsoorten','vocht','status','actief'];
  }
  $(selector) { return this.shadowRoot.querySelector(selector); }
  build() {
    this._built=true;
    const contents=[['houtsoorten','Houtsoorten'],['vocht','Vochtpercentage'],['status','Status (stookklaar / nog drogen)'],['laatste_meting','Datum laatste meting'],['vuldatum','Vuldatum en dagen sinds vullen'],['actief','Badge "Neem hier hout"']];
    this.shadowRoot.innerHTML=`<style>
      :host{display:block;color:var(--primary-text-color)}label{display:block;margin:16px 0 8px;font:inherit}
      input[type=text],select{box-sizing:border-box;width:100%;padding:12px;font:inherit;border:1px solid var(--divider-color);border-radius:8px;background:var(--secondary-background-color);color:inherit}
      .toggle{display:flex;align-items:center;gap:12px;margin:10px 0}.toggle input{width:20px;height:20px;accent-color:var(--primary-color)}p{color:var(--secondary-text-color);font-size:14px;line-height:1.5}h4{margin:22px 0 4px}
    </style><label for="title">Titel</label><input id="title" type="text"><label class="toggle"><input id="readonly" type="checkbox">Alleen-lezenkaart</label><p>Verberg de houtsoortkeuze, het invoerveld voor nieuwe vochtmetingen en de knop Meting opslaan. Het hokoverzicht en opgeslagen meetgegevens blijven zichtbaar.</p>
    <h4>Tegels</h4><label for="view">Weergave</label><select id="view"><option value="uitgebreid">Uitgebreid</option><option value="compact">Compact (nummer en percentage)</option></select>
    <label for="cols">Tegels per rij</label><select id="cols"><option value="auto">Automatisch</option>${[1,2,3,4,5,6,7,8].map(n=>`<option value="${n}">${n}</option>`).join('')}</select>
    <label class="toggle"><input id="verloop" type="checkbox">Toon verloop van de laatste metingen</label><label>Inhoud van de tegel</label>${contents.map(([key,text])=>`<label class="toggle"><input type="checkbox" data-item="${key}">${text}</label>`).join('')}`;
    const title=this.$('#title'), readonly=this.$('#readonly'), verloop=this.$('#verloop'), view=this.$('#view'), cols=this.$('#cols');
    title.addEventListener('input',()=>this.update('title',title.value));
    readonly.addEventListener('change',()=>this.update('read_only',readonly.checked));
    verloop.addEventListener('change',()=>{const c={...this.config};if(verloop.checked)delete c.verloop;else c.verloop=false;this.commit(c);});
    // Zonder eigen tegelinhoud hangen de standaardvinkjes af van de weergave: sync zet ze meteen juist.
    view.addEventListener('change',()=>{const c={...this.config};if(view.value==='compact')c.weergave='compact';else delete c.weergave;this.commit(c);this.sync();});
    cols.addEventListener('change',()=>{const c={...this.config};if(cols.value==='auto')delete c.kolommen;else c.kolommen=Number(cols.value);this.commit(c);});
    this.shadowRoot.querySelectorAll('[data-item]').forEach(box=>box.addEventListener('change',()=>{
      const chosen=[...this.shadowRoot.querySelectorAll('[data-item]')].filter(x=>x.checked).map(x=>x.dataset.item);
      this.update('tegelinhoud',chosen);
    }));
  }
  sync() {
    // Alleen waarden zetten; een veld dat de gebruiker op dit moment bewerkt, laten we met rust.
    const title=this.$('#title'), wanted=this.config.title??'Houtbeheer';
    if(this.shadowRoot.activeElement!==title && title.value!==wanted) title.value=wanted;
    this.$('#readonly').checked=Boolean(this.config.read_only);
    this.$('#verloop').checked=this.config.verloop!==false;
    this.$('#view').value=this.config.weergave==='compact'?'compact':'uitgebreid';
    this.$('#cols').value=String(this.config.kolommen??'auto');
    const items=this.items();
    this.shadowRoot.querySelectorAll('[data-item]').forEach(box=>{box.checked=items.includes(box.dataset.item);});
  }
}
if(!customElements.get('houtbeheer-card-editor'))customElements.define('houtbeheer-card-editor',HoutbeheerCardEditor);
if(!customElements.get('houtbeheer-card'))customElements.define('houtbeheer-card',HoutbeheerCard);
window.customCards=window.customCards||[];
window.customCards.push({type:'houtbeheer-card',name:'Houtbeheer',description:'Houthokken, houtsoorten en handmatige vochtmetingen.'});
