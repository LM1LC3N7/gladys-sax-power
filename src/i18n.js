// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys. Every text is a { en, fr } object. They never
// quote a byte of a battery: only our own words, error kinds, the addresses of
// the configuration, and the serial numbers, models and values read (numbers).
// -----------------------------------------------------------------------------

const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const hours = (ms) => Math.max(1, Math.round(ms / 3_600_000));
export const delay = (ms) => {
  // Decided on the rounded seconds: 59.99 s is "1 min", never "60 s".
  const s = Math.round(ms / 1000);
  if (s >= 2 * 3600) return { en: `${hours(ms)} h`, fr: `${hours(ms)} h` };
  if (s >= 60) return { en: `${minutes(ms)} min`, fr: `${minutes(ms)} min` };
  return { en: `${seconds(ms)} s`, fr: `${seconds(ms)} s` };
};

/** "18:02:05 UTC": an instant, never in the local time of a container. */
export const clock = (at) => `${new Date(at).toISOString().slice(11, 19)} UTC`;

/** Our words for an error kind of src/modbus/client.js (and "silent": connected, no block answered). */
const REASON = {
  unreachable: { en: 'unreachable', fr: 'injoignable' },
  timeout: { en: 'no answer in time', fr: 'pas de réponse à temps' },
  closed: { en: 'connection closed by the battery', fr: 'connexion fermée par la batterie' },
  protocol: {
    en: 'answer that is not Modbus TCP (is it the right address and port?)',
    fr: 'réponse qui n’est pas du Modbus TCP (est-ce la bonne adresse et le bon port ?)',
  },
  refused: { en: 'request refused', fr: 'requête refusée' },
  silent: {
    en: 'connected, but no register answered (is the Modbus interface enabled?)',
    fr: 'connecté, mais aucun registre n’a répondu (l’interface Modbus est-elle activée ?)',
  },
  aborted: { en: 'read stopped', fr: 'lecture arrêtée' },
};

export const reason = (kind) => REASON[kind] ?? { en: 'unexpected error', fr: 'erreur inattendue' };

/** The counters in the texts (src/devices.js COUNTERS names). */
export const COUNTER_NAMES = {
  produced: { en: 'energy produced', fr: 'énergie produite' },
  consumed: { en: 'energy consumed', fr: 'énergie consommée' },
};

/** The blocks in the texts (src/sax/registers.js keys). */
const BLOCK_NAMES = {
  identity: { en: 'serial number (SunSpec)', fr: 'numéro de série (SunSpec)' },
  battery: { en: 'battery values (unit 64)', fr: 'valeurs de la batterie (unité 64)' },
  inverter: { en: 'system values (SunSpec)', fr: 'valeurs du système (SunSpec)' },
  meter: { en: 'ADW200 meter (SunSpec)', fr: 'compteur ADW200 (SunSpec)' },
  storage: { en: 'storage values (SunSpec)', fr: 'valeurs du stockage (SunSpec)' },
  details: { en: 'details (unit 40)', fr: 'détails (unité 40)' },
  energy: { en: 'energy counters (unit 40)', fr: 'compteurs d’énergie (unité 40)' },
};

const kwh = (value) => Math.round(value * 1000) / 1000;

const sentences = (lang, list) => list.map((n) => n[lang]).join(' ');
const both = (list) => ({ en: sentences('en', list), fr: sentences('fr', list) });

/** "Battery A (192.168.1.50:502)". */
const name = (field, address) => {
  const letter =
    String(field ?? '')
      .slice(-1)
      .toUpperCase() || '?';
  return {
    en: `Battery ${letter}${address ? ` (${address})` : ''}`,
    fr: `Batterie ${letter}${address ? ` (${address})` : ''}`,
  };
};

const heldLine = ({ name: counter, battery, direction, from, to }) => {
  const who = name(battery);
  return direction === 'down'
    ? {
        en: `${who.en}, counter "${COUNTER_NAMES[counter].en}": dropped from ${kwh(from)} to ${kwh(to)} kWh, held back (the last accepted value is sent again).`,
        fr: `${who.fr}, compteur « ${COUNTER_NAMES[counter].fr} » : baisse de ${kwh(from)} à ${kwh(to)} kWh, retenue (la dernière valeur acceptée est renvoyée).`,
      }
    : {
        en: `${who.en}, counter "${COUNTER_NAMES[counter].en}": jumped from ${kwh(from)} to ${kwh(to)} kWh, held back (the last accepted value is sent again).`,
        fr: `${who.fr}, compteur « ${COUNTER_NAMES[counter].fr} » : saut de ${kwh(from)} à ${kwh(to)} kWh, retenu (la dernière valeur acceptée est renvoyée).`,
      };
};

const NOTE = {
  identifying: {
    en: 'no serial number read yet: nothing published until it is identified (a battery without the SunSpec interface is named after its address after 3 reads)',
    fr: 'aucun numéro de série lu pour l’instant : rien n’est publié tant qu’elle n’est pas identifiée (une batterie sans interface SunSpec prend le nom de son adresse après 3 lectures)',
  },
  unreadable: {
    en: 'serial number not readable this time: nothing published (its values only go to the device of its serial number)',
    fr: 'numéro de série illisible cette fois : rien n’est publié (ses valeurs ne vont qu’à l’appareil de son numéro de série)',
  },
  otherSerial: {
    en: 'another serial number answers at this address: its own device is in Discovery, the old one gets no value',
    fr: 'un autre numéro de série répond à cette adresse : son propre appareil est dans la Découverte, l’ancien ne reçoit plus de valeur',
  },
};

/** The line of one battery in the status (bounded: names and codes only). */
function batteryLine(view) {
  const who = name(view.field, view.address);
  if (view.error) {
    return {
      en: `${who.en}: not read (${reason(view.error).en}), new try in ${delay(view.wait).en}.`,
      fr: `${who.fr} : non lue (${reason(view.error).fr}), nouvel essai dans ${delay(view.wait).fr}.`,
    };
  }
  if (!view.outcomes && !view.read && !view.note) {
    return {
      en: `${who.en}: next read at ${clock(view.next)}.`,
      fr: `${who.fr} : prochaine lecture à ${clock(view.next)}.`,
    };
  }
  const parts = { en: [], fr: [] };
  if (view.id) {
    const what = `${view.model ?? 'SAX'} ${view.id}`;
    parts.en.push(`${what} answering`);
    parts.fr.push(`${what} répond`);
  } else {
    parts.en.push('answering');
    parts.fr.push('répond');
  }
  if (view.note) {
    parts.en.push(NOTE[view.note].en);
    parts.fr.push(NOTE[view.note].fr);
  }
  const missing = (view.missing ?? []).map((m) => BLOCK_NAMES[m.key]).filter(Boolean);
  if (missing.length > 0) {
    parts.en.push(`not read this time: ${missing.map((m) => m.en).join(', ')}`);
    parts.fr.push(`non lu cette fois : ${missing.map((m) => m.fr).join(', ')}`);
  }
  if (view.noDevice) {
    parts.en.push('create its device from the "Discover" tab to receive its values');
    parts.fr.push('créez son appareil depuis l’onglet « Découverte » pour recevoir ses valeurs');
  }
  return { en: `${who.en}: ${parts.en.join('; ')}.`, fr: `${who.fr} : ${parts.fr.join(' ; ')}.` };
}

const PROBLEM = {
  address_missing: {
    en: 'Enter the IP address of battery A (the master) in the configuration.',
    fr: 'Saisissez l’adresse IP de la batterie A (la maîtresse) dans la configuration.',
  },
  address_invalid: {
    en: 'is not a valid address: enter an IP address or a host name, with an optional port (e.g. 192.168.1.50).',
    fr: 'n’est pas une adresse valide : saisissez une adresse IP ou un nom d’hôte, avec un port éventuel (ex. 192.168.1.50).',
  },
  address_duplicate: {
    en: 'has the same address as another battery: each battery has its own address.',
    fr: 'a la même adresse qu’une autre batterie : chaque batterie a sa propre adresse.',
  },
};

export const T = {
  problem: (problem, field) => {
    const text = PROBLEM[problem] ?? PROBLEM.address_invalid;
    if (problem === 'address_missing') return text;
    const who = name(field);
    return { en: `${who.en} ${text.en}`, fr: `${who.fr} ${text.fr}` };
  },
  connecting: {
    en: 'Reading the SAX batteries…',
    fr: 'Lecture des batteries SAX…',
  },
  /** getConfig() failed in `connected`: asked again without end. */
  configRetry: (wait) => ({
    en: `The configuration could not be read from Gladys: new try in ${delay(wait).en}.`,
    fr: `La configuration n’a pas pu être lue depuis Gladys : nouvel essai dans ${delay(wait).fr}.`,
  }),
  /** Not read yet in this start: the next read. */
  waiting: (at, notes = []) =>
    both([
      { en: `SAX: next read at ${clock(at)}.`, fr: `SAX : prochaine lecture à ${clock(at)}.` },
      ...notes,
    ]),
  /** Every battery failing. */
  failing: (views, notes = []) => both([...views.map(batteryLine), ...notes]),
  ok: (views, notes = []) => both([...views.map(batteryLine), ...notes]),
  notes: {
    storeUnreadable: {
      en: 'The file of the integration in /data cannot be read: it is left as it is, no battery is named after its address and the energy counters are not sent until it can be read again (restart the integration).',
      fr: 'Le fichier de l’intégration dans /data est illisible : il est laissé tel quel, aucune batterie ne prend le nom de son adresse et les compteurs d’énergie ne sont pas envoyés tant qu’il ne peut pas être relu (redémarrez l’intégration).',
    },
    storeFailed: {
      en: 'The file of the integration in /data cannot be written: the energy counters are not sent meanwhile; the other values are.',
      fr: 'Le fichier de l’intégration dans /data ne peut pas être écrit : les compteurs d’énergie ne sont pas envoyés entre-temps ; les autres valeurs le sont.',
    },
    held: (held) =>
      both([
        ...held.map(heldLine),
        {
          en: 'A drop or a jump is never taken by itself. If the counter was really reset (or the battery replaced, or the jump is right), click "Accept the held counter" twice in the configuration of the integration (the first click lists, the second accepts exactly what was listed). Saving the configuration accepts nothing.',
          fr: 'Une baisse ou un saut n’est jamais pris de lui-même. Si le compteur a vraiment été remis à zéro (ou la batterie remplacée, ou si le saut est juste), cliquez deux fois sur « Accepter le compteur retenu » dans la configuration de l’intégration (le premier clic liste, le second accepte exactement ce qui a été listé). Enregistrer la configuration n’accepte rien.',
        },
      ]),
  },
  accept: {
    nothing: {
      en: 'No counter is held back: nothing to accept.',
      fr: 'Aucun compteur n’est retenu : rien à accepter.',
    },
    confirm: (held, within) =>
      both([
        {
          en: 'A second click accepts exactly these values:',
          fr: 'Un second clic accepte exactement ces valeurs :',
        },
        ...held.map((h) => {
          const who = name(h.battery);
          return h.direction === 'down'
            ? {
                en: `${who.en}, ${COUNTER_NAMES[h.name].en}: ${kwh(h.from)} → ${kwh(h.to)} kWh (a reset: the counter goes on from ${kwh(h.to)} kWh).`,
                fr: `${who.fr}, ${COUNTER_NAMES[h.name].fr} : ${kwh(h.from)} → ${kwh(h.to)} kWh (remise à zéro : le compteur reprend à ${kwh(h.to)} kWh).`,
              }
            : {
                en: `${who.en}, ${COUNTER_NAMES[h.name].en}: ${kwh(h.from)} → ${kwh(h.to)} kWh (${kwh(h.to - h.from)} kWh at once).`,
                fr: `${who.fr}, ${COUNTER_NAMES[h.name].fr} : ${kwh(h.from)} → ${kwh(h.to)} kWh (${kwh(h.to - h.from)} kWh d’un coup).`,
              };
        }),
        {
          en: `Click "Accept the held counter" again, after a few seconds and within ${delay(within).en}, to accept them; accept only if this is real.`,
          fr: `Cliquez de nouveau sur « Accepter le compteur retenu », après quelques secondes et dans les ${delay(within).fr}, pour les accepter ; n’acceptez que si c’est réel.`,
        },
      ]),
    done: (accepted, changed, stillHeld) =>
      both([
        ...accepted.map((h) => ({
          en: `Accepted: ${name(h.battery).en}, ${COUNTER_NAMES[h.name].en} ${kwh(h.to)} kWh, sent at the next read.`,
          fr: `Accepté : ${name(h.battery).fr}, ${COUNTER_NAMES[h.name].fr} ${kwh(h.to)} kWh, envoyé à la prochaine lecture.`,
        })),
        ...(changed.length > 0
          ? [
              {
                en: `Not accepted, the value changed since the first click: ${changed.map((h) => `${name(h.battery).en}, ${COUNTER_NAMES[h.name].en}`).join('; ')}. Click again to list it.`,
                fr: `Non accepté, la valeur a changé depuis le premier clic : ${changed.map((h) => `${name(h.battery).fr}, ${COUNTER_NAMES[h.name].fr}`).join(' ; ')}. Cliquez de nouveau pour la lister.`,
              },
            ]
          : []),
        ...(stillHeld
          ? [{ en: 'A different value stays held.', fr: 'Une autre valeur reste retenue.' }]
          : []),
      ]),
  },
  test: {
    /** One battery: what the last read gave (values when fresh), or why not, and the pace. */
    battery: (view, values, readAt) => {
      const line = batteryLine(view);
      const en = [line.en];
      const fr = [line.fr];
      if (values) {
        const shown = [];
        if (values.soc !== undefined) shown.push(`${values.soc} %`);
        if (values.power !== undefined) shown.push(`${Math.round(values.power)} W`);
        if (values.systemSoc !== undefined) shown.push(`system ${values.systemSoc} %`);
        if (shown.length > 0) {
          en.push(`Values: ${shown.join(', ')}.`);
          fr.push(`Valeurs : ${shown.join(', ').replace('system', 'système')}.`);
        }
        en.push(`Last read at ${clock(readAt)}.`);
        fr.push(`Dernière lecture à ${clock(readAt)}.`);
      } else if (!view.error) {
        en.push(
          `Not asked now (never faster than the reading interval): next read possible at ${clock(view.next)}.`,
        );
        fr.push(
          `Non interrogée maintenant (jamais plus vite que l’intervalle de lecture) : prochaine lecture possible à ${clock(view.next)}.`,
        );
      }
      return { en: en.join(' '), fr: fr.join(' ') };
    },
    slow: {
      en: 'A battery is slow to answer: look at the integration status in a minute.',
      fr: 'Une batterie tarde à répondre : regardez l’état de l’intégration dans une minute.',
    },
    lines: (lines) => both(lines),
  },
};
