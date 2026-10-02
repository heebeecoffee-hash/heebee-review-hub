// ═══════════════════════════════════════════════════════
// HEEBEE REPLY BRAIN — offline reply suggestions, no external AI.
// Reads a review, works out what it's about (topics praised / complained
// about, items, staff names, language) and composes replies in Heebee's own
// voice, learned from ~2,200 real reviews and the team's past replies.
// Same review + same seed → same suggestions; bump the seed for new ideas.
// ═══════════════════════════════════════════════════════
(function (root) {
  const CARE_EMAIL = 'care@heebee.in';
  const SIGNOFF = 'Stay happy, stay caffeinated ❤️';
  const BRANCH = { b1: 'Sarabha Nagar', b2: 'Ghumar Mandi', b3: 'Model Town' };

  // ── Topics ────────────────────────────────────────────
  // rx: what signals the topic. praise / fix: lines used when it's praised or
  // complained about. {item} is replaced by the item the customer named.
  const TOPICS = [
    { key: 'taste', label: 'Coffee taste',
      rx: /\b(watery|water|bland|tasteless|flavou?rless|bitter|too sweet|so sweet|all sugar|no sugar|not sweet|essence|burnt|weak|strong)\b/i,
      praise: ['Getting the flavour just right matters a lot to us, so this means a lot.'],
      fix: ['A {item} that tastes off is not what we stand for — our barista team is rechecking the recipe and shots.',
            'We have flagged the taste of your {item} with our barista team so it is fixed. You can always ask our baristas to remake a drink you are not happy with.'] },
    { key: 'coffee', label: 'Coffee',
      rx: /\b(coffee|coffe|cofee|latte|cappuc+ino|espresso|americano|frappe|fapio|mocha|cold brew|macchiato|flat white|hot chocolate|chai|brew)\b/i,
      praise: ['So glad you loved the {item}! Our baristas take real pride in every cup.',
               'Great coffee is what we live for, so hearing you enjoyed the {item} made our day.',
               'Your love for our {item} means the world to our baristas.'],
      fix: ['We are sorry the {item} was not up to the mark — our barista team has been asked to look into it.',
            'A {item} like that is not the Heebee standard. We have shared this with our baristas, and you can always ask them to remake a drink you are not happy with.'] },
    { key: 'food', label: 'Food',
      rx: /\b(food|sandwich|pizza|pasta|cake|cheese ?cake|fries|wrap|bread|brownie|burger|waffle|croissant|parfait|noodles?|paneer|bagel|toast|dish|meal|platter|salad|steak|muffin|dessert|snacks?|potato(es)?|cheese|kulcha|hot ?dog|nachos|garlic bread)\b/i,
      praise: ['Happy to hear the {item} was a hit — our kitchen team will be thrilled.',
               'We are so glad you enjoyed the {item}! Our kitchen puts a lot of love into it.'],
      fix: ['We are sorry the {item} did not meet your expectations — our kitchen team has been alerted to check freshness and preparation.',
            'That is not how our {item} should be. Our kitchen team is looking into it so it does not happen again.'] },
    { key: 'temperature', label: 'Served cold',
      rx: /\b(lukewarm|not hot|went cold|was cold|were cold|cold food|food was cold|coffee was cold|arrived cold|served cold)\b/i,
      praise: [],
      fix: ['Everything should reach you at the right temperature — we are tightening our serving times so this does not happen again.'] },
    { key: 'wait', label: 'Wait time',
      rx: /\b(slow|wait(ed|ing)?|late|delay(ed)?|queue|took \d+|\d+ ?min(ute)?s|an hour|one hour|forever|billing|on time|quick|fast|prompt)\b/i,
      praise: ['Glad the service was quick and smooth for you!'],
      fix: ['Waiting that long is not okay. We are working on faster billing and service, especially during busy hours.',
            'We are sorry for the delay — speeding up service at peak times is a priority for our team right now.'] },
    { key: 'staff', label: 'Staff',
      rx: /\b(staff|barista|waiter|server|manager|rude|behaviou?r|attitude|polite|friendly|helpful|hospitality|courteous|served by|team|employees?)\b/i,
      praise: ['Our team will be delighted to hear they made your visit special.',
               'Warm hospitality is at the heart of Heebee, so this means a lot to our team.'],
      fix: ['We are truly sorry for how you were treated. This is being addressed with our team, because warm hospitality is at the heart of what we do.',
            'That is not the welcome we want anyone to have at Heebee — we are addressing it with the outlet team.'] },
    { key: 'service', label: 'Service',
      rx: /\bservices?\b/i,
      praise: ['So glad our team looked after you well!'],
      fix: ['We are sorry the service fell short of what you deserve — we are working on it with the outlet team.'] },
    { key: 'ambience', label: 'Ambience',
      rx: /\b(ambien[cs]e|ambian[cs]e|vibes?|atmosphere|cozy|cosy|decor|interior|aesthetic|aura|environment|enviournment|music|seating|sitting area|nice place|lovely place|beautiful place|great place|cute place)\b/i,
      praise: ['We put a lot of love into making the café a cosy space, so we are glad you enjoyed the vibe.',
               'So happy the vibe felt right — that is exactly what we hope every visit feels like.'],
      fix: ['We are sorry the space did not feel comfortable — we have raised this with the outlet team.'] },
    { key: 'comfort', label: 'AC / seating',
      rx: /\b(ac|a\.c|air condition\w*|no seating|seats? (were )?occupied|no place to sit|too hot inside|crowded|noisy|loud)\b/i,
      praise: [],
      fix: ['We are sorry the café was not comfortable — we have asked the outlet team to fix the seating and cooling issues.'] },
    { key: 'price', label: 'Price / quantity',
      rx: /\b(rates?|exorbitant|price|pricing|priced|expensive|costly|over ?priced|value for money|worth|quantity|portion|so little|too little|scam|money)\b/i,
      praise: ['Happy to hear you found it great value!'],
      fix: ['We hear you on value. Your feedback on pricing and portion size has been shared with our team.'] },
    { key: 'hygiene', label: 'Cleanliness',
      rx: /\b(dirty|unclean|clean|hygien\w*|fly|flies|insects?|hair|washroom|smell|stink)\b/i,
      praise: ['Thank you for noticing — keeping the café spotless matters a lot to us.'],
      fix: ['Cleanliness is non-negotiable for us, and the outlet team has been asked to look into this right away.'] },
    { key: 'delivery', label: 'Delivery / packaging',
      rx: /\b(deliver(y|ed)?|packag\w*|packed|spill\w*|leak\w*|seal(ed)?|missing|did ?n[o']?t receive|not received|wrong (item|order)|instead|sent|cutlery|spoon|zomato|swiggy)\b/i,
      praise: ['Glad your order reached you safe, sound and on time!'],
      fix: ['We are sorry your order did not reach you the way it should have — we are rechecking packaging, sealing and order checks on every delivery.',
            'Spilled, missing or wrong items should never happen — our packing team has been alerted to double-check every delivery order.'] },
    { key: 'availability', label: 'Item unavailable',
      rx: /\b(not available|unavailable|out of stock|ran out|sold out)\b/i,
      praise: [],
      fix: ['Sorry the item you wanted was not available — we are working on keeping the full menu stocked.'] }
  ];

  const NEG = /\b(not|no|never|worst|bad|poor|pathetic|disappoint\w*|slow|rude|watery|bland|tasteless|stale|dirty|expensive|over ?priced|late|missing|wrong|spill\w*|leak\w*|raw|hard|bitter|waste|upset|unhappy|did ?n[o']?t|does ?n[o']?t|was ?n[o']?t|over ?hyped|horrible|terrible|awful|disaster|cold|lukewarm|issue|problem|complain\w*|improve|scam|less|little|delay\w*|small|tiny|exorbitant|shit|crap|lack\w*|average|ok|okay|meh|only one|single)\b/gi;
  const POS = /\b(good|great|best|amazing|excellent|nice|love|loved|lovely|delicious|tasty|perfect|awesome|friendly|polite|cozy|cosy|wonderful|superb|fantastic|recommend\w*|must|immaculate|helpful|quick|fast|beautiful|fresh|yummy|favou?rite|happy|enjoyed|outstanding|mast|badhiya|vadiya|accha|acha)\b/gi;
  const HINGLISH = /\b(bahut|bohot|acha|accha|achha|hai|tha|thi|nahi|nhi|bhai|yaar|mast|ekdum|khana|swad|vadiya|badhiya|bekar|bekaar|thik|theek|kaafi|kafi|bilkul|pasand|sahi|bakwas|ji)\b/gi;

  const ITEMS = ['iced latte', 'hot chocolate', 'cold brew', 'cold coffee', 'flat white', 'chin chin chu cake', 'cheese cake', 'cheesecake',
    'cappuccino', 'cappucino', 'americano', 'espresso', 'macchiato', 'frappe', 'fapio', 'mocha', 'latte', 'chai',
    'garlic bread', 'pasta', 'pizza', 'sandwich', 'fries', 'wrap', 'brownie', 'burger', 'waffle', 'croissant', 'parfait',
    'pad thai', 'noodles', 'kulcha', 'hotdog', 'hot dog', 'nachos', 'potatoes', 'bagel', 'toast', 'platter', 'salad', 'steak', 'smoothie', 'muffin', 'cake'];
  const NOT_NAMES = /^(The|This|That|Heebee|Hee|Bee|Coffee|Cafe|Café|Ludhiana|Jalandhar|Sarabha|Nagar|Model|Town|Ghumar|Mandi|Zomato|Swiggy|Google|Very|Good|Great|Best|Staff|Service|Mr|Ms|Mrs|Miss|Sir|Mam|Maam|Our|They|She|He|It|We|I)$/;

  // ── helpers ───────────────────────────────────────────
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { let a = seed; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
  const count = (rx, s) => (String(s).match(rx) || []).length;

  function firstName(reviewer) {
    const n = String(reviewer || '').trim().split(/\s+/)[0] || '';
    if (!n || /^(anonymous|a|google|user|guest|customer|test)$/i.test(n) || !/^[A-Za-zऀ-੿]{2,}$/.test(n)) return '';
    return cap(n);
  }

  function findItem(text) {
    const t = String(text).toLowerCase();
    for (const it of ITEMS) if (new RegExp('\\b' + it.replace(/ /g, '\\s*') + '\\b').test(t)) return it.replace('cappucino', 'cappuccino').replace('cheese cake', 'cheesecake');
    return '';
  }

  function staffNames(text) {
    const out = new Set();
    const rxs = [/(?:service|served|attended|helped)\s+by\s+(?:mr\.?\s*|ms\.?\s*|miss\s+)?([A-Z][a-z]{2,})/g,
                 /\b([A-Z][a-z]{2,})\s+(?:was|is)\s+(?:very\s+|so\s+|really\s+)?(?:helpful|friendly|polite|great|amazing|sweet|kind|courteous|good)/g];
    rxs.forEach(rx => { let m; while ((m = rx.exec(text))) if (!NOT_NAMES.test(m[1])) out.add(m[1]); });
    return [...out];
  }

  // ── analysis ──────────────────────────────────────────
  function analyse(r) {
    const text = String(r.text || '')
      .replace(/\n*(Ordered:|Staff rating:)[\s\S]*$/i, '')     // QR-form extras appended by the backend
      .replace(/⚠️ No rating provided/g, '')
      .replace(/¬∑/g, '·');
    const rating = r.unrated ? 0 : Number(r.rating) || 0;
    const band = !rating ? 'mixed' : rating >= 4 ? 'positive' : rating <= 2 ? 'negative' : 'mixed';

    const praised = new Set(), complained = new Set(), itemFor = {};
    const deliveryContext = /zomato|swiggy/.test(r.platform) || /\b(deliver\w*|packag\w*|parcel|takeaway|take away)\b/i.test(text);
    const clauses = text.split(/[.!?\n·]+|\bbut\b|\bhowever\b|\bexcept\b|\bthough\b|suggestion:/i).filter(c => c.trim());
    clauses.forEach(c => {
      const score = count(POS, c) - count(NEG, c);
      const tone = score > 0 ? 'p' : score < 0 ? 'n' : (band === 'positive' ? 'p' : band === 'negative' ? 'n' : '');
      TOPICS.forEach(t => {
        if (!t.rx.test(c)) return;
        if (t.key === 'temperature' && /cold (coffee|brew)/i.test(c) && !/was cold|went cold|served cold/i.test(c)) return;
        if (t.key === 'delivery' && !deliveryContext) return;
        if (tone === 'p' && t.praise.length) praised.add(t.key);
        else if (tone === 'n' && t.fix.length) complained.add(t.key);
        else return;
        if (!itemFor[t.key]) itemFor[t.key] = findItem(c);
      });
    });
    // a more specific complaint replaces the generic one
    if (complained.has('taste')) complained.delete('coffee');
    if (complained.has('temperature') || complained.has('delivery')) { complained.delete('food'); complained.delete('coffee'); }
    if (complained.has('comfort')) complained.delete('ambience');
    if (complained.has('wait') || complained.has('staff')) complained.delete('service');
    if (praised.has('wait') || praised.has('staff')) praised.delete('service');
    complained.forEach(k => praised.delete(k));

    const hasPositiveWords = count(POS, text) > 0;
    const effBand = band === 'mixed' && !complained.size && hasPositiveWords ? 'positive'
                  : band === 'positive' && complained.size >= 2 && !praised.size ? 'mixed' : band;

    return {
      text, rating, band: effBand, name: firstName(r.reviewer),
      praised: [...praised], complained: [...complained],
      itemFor: itemFor, item: findItem(text), staff: staffNames(text),
      hinglish: count(HINGLISH, text) >= 2 || /[ऀ-੿]/.test(text),
      isPublic: r.platform !== 'heebee', platform: r.platform,
      branchKey: r.branch, branch: BRANCH[r.branch] || ''
    };
  }

  const topic = k => TOPICS.find(t => t.key === k);

  const DRINK = /latte|coffee|cappuccino|americano|espresso|macchiato|frappe|fapio|mocha|chai|brew|chocolate|flat white|smoothie/;
  // Only use an item named in the same sentence as the topic, and only if it
  // is the right kind (a drink for coffee/taste, a dish for food).
  function fill(line, a, k) {
    const generic = k === 'coffee' || k === 'taste' ? 'coffee' : k === 'food' ? 'food' : 'order';
    const it = (a.itemFor || {})[k] || '';
    const fits = it && (k === 'food' ? !DRINK.test(it) : (k === 'coffee' || k === 'taste') ? DRINK.test(it) : false);
    return line.replace(/\{item\}/g, fits ? it : generic)
      .replace(/\b([Aa]) (?=[aeiou])/g, (m, A) => A + 'n ');   // a iced latte → an iced latte
  }

  // ── reply composition ─────────────────────────────────
  function suggest(r, seed) {
    const a = analyse(r);
    const R = rng(hash(String(r.id || r.text)) + (seed || 0) * 7919);
    const pick = arr => arr[Math.floor(R() * arr.length)];
    const hi = a.name ? pick(['Hi ' + a.name + ',', 'Hey ' + a.name + '!', 'Dear ' + a.name + ',']) : pick(['Hi there,', 'Hey!', 'Hello,']);
    const at = a.branch ? ' at ' + a.branch : '';
    const contact = a.isPublic
      ? 'Please share your order details and the contact number on your bill at ' + CARE_EMAIL + ' so our team can make this right for you.'
      : 'Just reply here with your bill details and our team will make this right for you.';
    const praiseLines = a.praised.slice(0, 2).map(k => fill(pick(topic(k).praise), a, k));
    const fixLines = a.complained.slice(0, 2).map(k => fill(pick(topic(k).fix), a, k));
    const staffLine = a.staff.length && a.band !== 'negative'
      ? pick(['We will make sure ' + a.staff.join(' and ') + ' hears your kind words!', 'Shoutout passed on to ' + a.staff.join(' and ') + ' — thank you for noticing!'])
      : '';
    const fourStar = a.rating === 4 ? 'We would love to know what would make it a 5 next time!' : '';
    const takeaway = a.branchKey === 'b2' && a.complained.includes('comfort')
      ? 'Our Ghumar Mandi outlet is takeaway-only — for dine-in we would love to host you at Sarabha Nagar.' : '';
    const out = [];
    const add = (tone, parts) => out.push({ tone, text: parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
      .replace(/^([^!.]*?,) ([A-Z])(?=[a-z])/, (m, g, c) => g + ' ' + c.toLowerCase()) });

    if (a.band === 'positive') {
      add('Warm & personal', [hi, pick(['Thank you so much for the lovely review!', 'Thank you for taking the time to share this!', 'This made our day — thank you!']),
        ...praiseLines, staffLine, fixLines[0] ? 'And thank you for the note — ' + fixLines[0].charAt(0).toLowerCase() + fixLines[0].slice(1) : '',
        fourStar, pick(['We cannot wait to welcome you back' + at + '.', 'See you again soon' + at + '!']), SIGNOFF]);
      add('Short & sweet', [hi, pick(['Thank you for the love!', 'So happy you enjoyed it!', 'Thank you so much!']),
        praiseLines[0] || '', a.rating === 4 ? fourStar : '', SIGNOFF]);
      add('Classic Heebee', [a.name ? 'Hi ' + a.name + ',' : '', 'Thank you for your valuable feedback.',
        a.rating === 4 ? 'We would like to know where we lacked and lost one star in your rating. Help us serve you only the best!'
                       : 'We promise to keep serving you with only the best.', SIGNOFF]);
    } else if (a.band === 'negative') {
      add('Sincere apology', [hi, pick(['We are truly sorry about your experience' + at + '.', 'We sincerely apologise for the experience you had' + at + '.']),
        ...(fixLines.length ? fixLines : ['This is not the standard we hold ourselves to at Heebee, and we have shared your feedback with our team.']),
        contact, 'We would really value the chance to serve you better.']);
      add('Make it right', [hi, 'We are sorry we let you down — this is not the Heebee experience we want for anyone.',
        fixLines[0] || '', contact]);
      add('Brief & sincere', [hi, 'We sincerely apologise for the experience you had. This is not the standard we hold ourselves to at Heebee.',
        'Your feedback has been shared with our team and we are working to improve.', a.isPublic ? 'Please reach us at ' + CARE_EMAIL + '.' : '']);
    } else {
      add('Balanced', [hi, 'Thank you for the honest feedback!', ...praiseLines,
        fixLines.length ? 'At the same time, we are sorry things were not perfect.' : '', ...fixLines,
        'We hope to give you a 5-star experience next time' + at + '.', SIGNOFF]);
      add('Grateful', [hi, 'Thank you for sharing this with us.', praiseLines[0] || '', fixLines[0] || 'Your feedback helps us get better every day.',
        'Hope to see you again soon!', SIGNOFF]);
      add('Follow-up', [hi, 'Thank you for your feedback — we would love to understand what we could have done better.',
        fixLines[0] || '', a.isPublic ? 'Please write to us at ' + CARE_EMAIL + ' so our team can follow up personally.' : 'Just reply here and our team will follow up personally.']);
    }

    if (a.hinglish) {
      const nm = a.name ? a.name + ' ji' : 'Aap';
      out[2] = a.band === 'negative'
        ? { tone: 'Hinglish', text: nm + ', humein sach mein bahut afsos hai. Aapka feedback humne apni team ke saath share kar diya hai aur hum isse theek karenge. ' +
            (a.isPublic ? 'Please apni order details ' + CARE_EMAIL + ' pe bhejiye.' : 'Bas yahin apni bill details bhej dijiye.') }
        : { tone: 'Hinglish', text: (a.name ? 'Thank you ' + a.name + ' ji! ' : 'Thank you so much! ') +
            (a.item ? 'Aapko ' + a.item + ' pasand aaya, yeh sunke bahut accha laga. ' : 'Aapka pyaar dekh ke bahut accha laga. ') + 'Jaldi milte hain! ' + SIGNOFF };
    }
    return { analysis: a, suggestions: out };
  }

  // Best-matching saved template for this review (or null)
  function matchTemplate(r, templates) {
    const a = analyse(r);
    let best = null, bestScore = 0;
    (templates || []).forEach(t => {
      const s = (t.name + ' ' + t.text).toLowerCase();
      let score = 0;
      if (a.band === 'positive' && /thank|positive|praise|thrilled/.test(s)) score += 2;
      if (a.band === 'negative' && /apolog|sorry|critical|escalat/.test(s)) score += 2;
      if (a.complained.includes('wait') && /slow|wait/.test(s)) score += 3;
      if (a.complained.includes('delivery') && /deliver|packag/.test(s)) score += 3;
      if (a.praised.includes('food') && /food|quality/.test(s)) score += 1;
      if (score > bestScore) { bestScore = score; best = t; }
    });
    return best;
  }

  const api = { analyse, suggest, matchTemplate, TOPICS };
  if (typeof module !== 'undefined') module.exports = api; else root.ReplyBrain = api;
})(typeof window !== 'undefined' ? window : globalThis);
