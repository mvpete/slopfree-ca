(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const CONFIG = window.SLOPFREE_CONFIG || {};
  const API = (CONFIG.api || "").replace(/\/$/, "");
  const ROUNDS = 5;
  // Guess rounds (question with no summary) are off: with a handful of readers they'd use up scarce answers.
  const GUESS_RATE = 0;

  // Articles this browser has already seen. Reading the same article twice would mean remembering the answer.
  const SEEN_KEY = "slopfree:seen";
  function seenSlugs() {
    try {
      return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || "[]"));
    } catch (e) {
      return new Set();
    }
  }
  function markSeen(slugs) {
    try {
      const all = seenSlugs();
      slugs.forEach((s) => all.add(s));
      localStorage.setItem(SEEN_KEY, JSON.stringify([...all].slice(-500)));
    } catch (e) {
      /* storage blocked: repeats become possible, nothing else breaks */
    }
  }

  // ---------- Copy golden prompt (any button with .copy-golden) ----------
  document.querySelectorAll(".copy-golden").forEach((b) => b.addEventListener("click", (e) => {
    const btn = e.currentTarget;
    const done = (label) => {
      btn.textContent = label;
      setTimeout(() => (btn.textContent = btn.dataset.label), 1500);
    };
    const selectText = () => {
      const range = document.createRange();
      range.selectNodeContents($("golden"));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      done("Selected, press Ctrl+C");
    };
    try {
      navigator.clipboard.writeText($("golden").textContent).then(() => done("Copied"), selectText);
    } catch (err) {
      selectText();
    }
  }));

  // ---------- Highlight the menu item for the section on screen ----------
  const links = document.querySelectorAll(".topbar nav a[data-section]");
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        links.forEach((a) => a.classList.toggle("active", a.dataset.section === entry.target.id));
      });
    },
    { rootMargin: "-45% 0px -45% 0px" }
  );
  document.querySelectorAll("main > section").forEach((s) => observer.observe(s));

  // ---------- Sample content, used when content/index.json isn't available ----------
  const SAMPLE_ARTICLES = [
    {
      title: "Halifax Explosion",
      text: "On 6 December 1917, the French cargo ship Mont-Blanc, loaded with wartime explosives, collided with the Norwegian ship Imo in the Narrows of Halifax Harbour. The collision started a fire on the Mont-Blanc, and about twenty minutes later its cargo exploded. The blast flattened much of the city's north end and killed around 2,000 people.",
      q: "What set off the Halifax Explosion?",
      options: ["A bombing raid on the harbour", "A fire after two ships collided", "A boiler failure in a munitions factory", "Lightning striking an ammunition depot"],
      answer: 1,
    },
    {
      title: "Tardigrade",
      text: "Tardigrades are animals under a millimetre long that live in moss, soil and water. They survive drying out by entering cryptobiosis: they pull in their legs, lose almost all their body water and curl into a dormant form called a tun. Their metabolism nearly stops until water returns.",
      q: "What is a tardigrade's dried-out, dormant form called?",
      options: ["A cyst", "A spore", "A tun", "A pupa"],
      answer: 2,
    },
    {
      title: "Lake Nyos disaster",
      text: "In August 1986, Lake Nyos in Cameroon suddenly released a large cloud of carbon dioxide that had built up in its deep water. Because carbon dioxide is heavier than air, the cloud flowed into nearby valleys and displaced the oxygen. About 1,700 people suffocated. Pipes now vent gas from the lake to prevent another eruption.",
      q: "Why did the gas cloud kill people in the valleys below the lake?",
      options: ["It was poisonous in small amounts", "It was hot enough to cause burns", "It was heavier than air and displaced the oxygen", "It ignited and caused fires"],
      answer: 2,
    },
    {
      title: "Canadarm",
      text: "The Canadarm was a robotic arm built in Canada for NASA's Space Shuttle. Astronauts operated it from the cabin to move cargo, release and capture satellites, and hold crew during spacewalks. It first flew on STS-2 in 1981, and its success led Canada to build Canadarm2 for the International Space Station.",
      q: "What was the Canadarm mainly used for?",
      options: ["Moving cargo and handling satellites from the Space Shuttle", "Docking the Shuttle to the space station", "Steering the Shuttle during re-entry", "Collecting rock samples on the Moon"],
      answer: 0,
    },
    {
      title: "Octopus",
      text: "An octopus has three hearts: two pump blood through the gills and one pumps it to the rest of the body. Its blood is blue because it carries oxygen with hemocyanin, a copper-based protein, rather than iron-based hemoglobin. Hemocyanin works well in cold, low-oxygen water.",
      q: "Why is octopus blood blue?",
      options: ["It contains very little oxygen", "It uses a copper-based protein to carry oxygen", "It absorbs blue light from seawater", "It has no red blood cells at all"],
      answer: 1,
    },
  ];
  const SAMPLE = {
    sample: true,
    models: {
      openai: {
        label: "OpenAI",
        golden: { id: "p-0001", text: null },
        challenger: null,
        eval: null,
        articles: SAMPLE_ARTICLES.map((a) => ({
          slug: a.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          title: a.title,
          url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(a.title.replace(/ /g, "_")),
          question: { text: a.q, options: a.options, answer: a.answer },
          summaries: { "p-0001": a.text },
        })),
      },
    },
  };

  let DATA = SAMPLE;
  let READERS = null;
  const recording = () => !DATA.sample && !!API;

  // ---------- Page content from the index ----------
  const pct = (x) => Math.round(x * 100) + "%";
  // Files use p-0001; people see "1".
  const promptName = (id) => String(Number(String(id).replace(/^p-/, "")));

  function renderPage() {
    const keys = Object.keys(DATA.models);
    const first = DATA.models[keys[0]];
    if (first.golden.text) $("golden").querySelector("code").textContent = first.golden.text;

    const cap = $("golden-caption");
    cap.textContent = "";
    const add = (text, strong) => {
      const el = document.createElement(strong ? "strong" : "span");
      el.textContent = text;
      cap.appendChild(el);
    };
    add("Golden prompt ");
    add(promptName(first.golden.id), true);
    if (first.eval && first.eval.passed) {
      add(first.eval.coverage >= 1 ? " · as many facts as a plain summary in " : ` · ${pct(first.eval.coverage)} of a plain summary's facts in `);
      add(pct(first.eval.shorter), true);
      add(" less text");
    }
    if (READERS && READERS[keys[0]]) {
      add(" · ");
      add(READERS[keys[0]].toLocaleString(), true);
      add(" readers");
    }
    if (!first.eval) add(" · paste it at the end of any prompt");

    const line = $("eval-line");
    if (first.eval) {
      line.textContent = first.eval.passed
        ? `Latest eval (${first.eval.date}, ${first.eval.articles} articles): the golden prompt kept ${pct(first.eval.coverage)} as many of the articles' points as a plain summary, in ${pct(first.eval.shorter)} fewer words.`
        : `Latest eval (${first.eval.date}): the golden prompt didn't pass this week. It's being revised.`;
      if (first.eval.writerModel) line.textContent += ` Summaries by ${first.eval.writerModel}, judged by ${first.eval.judgeModel}.`;
      line.hidden = false;
    }

    // One model for now, so the quiz just starts. Bring back a model picker here if a second model is added.
    $("start").onclick = () => startQuiz(keys[0]);

    const note = $("mode-note");
    note.hidden = recording();
    note.textContent = DATA.sample
      ? "Practice mode: sample summaries, and answers aren't recorded."
      : "Practice mode: answers aren't recorded on this copy of the site.";
  }

  fetch("content/index.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d && d.models && Object.keys(d.models).length) DATA = d;
    })
    .catch(() => {})
    .finally(() => {
      renderPage();
      if (recording()) {
        fetch(API + "/v1/stats")
          .then((r) => (r.ok ? r.json() : null))
          .then((s) => {
            if (s && s.readers) { READERS = s.readers; renderPage(); }
          })
          .catch(() => {});
      }
    });

  // ---------- Quiz ----------
  const stages = ["intro", "read", "question", "lang", "result"];
  const show = (name) => stages.forEach((s) => ($("stage-" + s).hidden = s !== name));
  const shuffle = (xs) => {
    const a = xs.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const words = (s) => (s.trim().match(/\S+/g) || []).length;

  let model = null;
  let rounds = [];
  let round = 0;
  let readStart = 0;
  let hiddenWhileReading = false;
  let turnstileToken = null;

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && !$("stage-read").hidden) hiddenWhileReading = true;
  });

  function startQuiz(key) {
    model = key;
    const m = DATA.models[key];
    const ids = m.challenger ? [m.golden.id, m.challenger] : [m.golden.id];
    const usable = shuffle(m.articles.filter((a) => ids.every((id) => a.summaries[id])));
    const seen = seenSlugs();
    const fresh = usable.filter((a) => !seen.has(a.slug));
    if (!DATA.sample && fresh.length === 0) {
      $("mode-note").textContent = "You've read every article this week. New ones arrive Friday.";
      $("mode-note").hidden = false;
      return;
    }
    // Unseen articles first; sample content may repeat.
    const picks = (DATA.sample ? usable : fresh).slice(0, ROUNDS);
    if (!DATA.sample) markSeen(picks.map((a) => a.slug));
    // Mix golden and challenger in every session, so each reader is compared with themselves.
    const start = Math.random() < 0.5 ? 0 : 1;
    const assigned = shuffle(picks.map((_, i) => ids[(i + start) % ids.length]));
    rounds = picks.map((a, i) => ({ article: a, promptId: assigned[i], guess: !DATA.sample && Math.random() < GUESS_RATE }));
    round = 0;
    startRound();
  }

  function renderDots() {
    const dots = $("dots");
    dots.innerHTML = "";
    rounds.forEach((_, i) => {
      const d = document.createElement("i");
      if (i < round) d.className = "done";
      if (i === round) d.className = "now";
      dots.appendChild(d);
    });
  }

  function startRound() {
    const r = rounds[round];
    const label = `Round ${round + 1} of ${rounds.length}`;
    $("round-label").textContent = label;
    $("round-label-q").textContent = label;
    $("quiz").scrollIntoView({ block: "start" });
    if (r.guess) {
      r.readMs = 0;
      r.words = 0;
      showQuestion();
      return;
    }
    const text = r.article.summaries[r.promptId];
    $("topic").textContent = r.article.title;
    const box = $("paragraph");
    box.innerHTML = "";
    text.split(/\n\s*\n/).forEach((para) => {
      const p = document.createElement("p");
      p.textContent = para.trim();
      box.appendChild(p);
    });
    r.words = words(text);
    renderDots();
    show("read");
    hiddenWhileReading = false;
    readStart = performance.now();
  }

  function showQuestion() {
    const r = rounds[round];
    if (!r.guess) {
      r.readMs = Math.round(performance.now() - readStart);
      r.hidden = hiddenWhileReading;
    }
    $("guess-note").hidden = !r.guess;
    const fs = $("choices");
    fs.querySelectorAll(".choice").forEach((c) => c.remove());
    $("question").textContent = r.article.question.text;
    // Shuffle the display order; record the original option index.
    shuffle(r.article.question.options.map((text, i) => ({ text, i }))).forEach((o) => {
      const label = document.createElement("label");
      label.className = "choice";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "answer";
      input.value = o.i;
      input.addEventListener("change", () => ($("submit").disabled = false));
      const span = document.createElement("span");
      span.textContent = o.text;
      label.append(input, span);
      fs.appendChild(label);
    });
    $("submit").disabled = true;
    show("question");
    fs.querySelector("input").focus();
  }

  function submitAnswer() {
    const picked = document.querySelector('#choices input[name="answer"]:checked');
    if (!picked) return;
    const r = rounds[round];
    r.choice = Number(picked.value);
    r.correct = r.choice === r.article.question.answer;
    nextRound();
  }

  // "Too hard / I don't know": stored as choice 4, which counts as a wrong answer.
  const TOO_HARD = 4;
  function tooHard() {
    const r = rounds[round];
    r.choice = TOO_HARD;
    r.correct = false;
    r.tooHard = true;
    nextRound();
  }

  function nextRound() {
    round++;
    if (round < rounds.length) startRound();
    else if (recording()) askLanguage();
    else showResult(null);
  }

  // ---------- First-language question, bot check, and submit ----------
  function askLanguage() {
    show("lang");
    const buttons = document.querySelectorAll(".lang-btn");
    if (CONFIG.turnstileSiteKey) {
      buttons.forEach((b) => (b.disabled = true));
      loadTurnstile(() => {
        $("turnstile").innerHTML = "";
        turnstileToken = null;
        window.turnstile.render("#turnstile", {
          sitekey: CONFIG.turnstileSiteKey,
          theme: "dark",
          callback: (t) => {
            turnstileToken = t;
            buttons.forEach((b) => (b.disabled = false));
          },
        });
      });
    }
  }

  function loadTurnstile(cb) {
    if (window.turnstile) return cb();
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = cb;
    s.onerror = () => document.querySelectorAll(".lang-btn").forEach((b) => (b.disabled = false));
    document.head.appendChild(s);
  }

  document.querySelectorAll(".lang-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const lang = b.dataset.lang || null;
      showResult("Saving your answers…");
      record(lang).then(
        () => setStatus("Saved. Your answers now count toward this week's ranking."),
        (e) => setStatus(`Your answers weren't saved: ${e.message}`)
      );
    })
  );

  function record(firstLanguage) {
    const body = {
      model,
      firstLanguage,
      token: turnstileToken,
      answers: rounds.map((r, i) => ({
        promptId: r.promptId,
        slug: r.article.slug,
        choice: r.choice,
        readMs: r.readMs,
        words: r.words,
        round: i + 1,
        guess: r.guess,
        hidden: !!r.hidden,
      })),
    };
    return fetch(API + "/v1/results", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then((res) => res.json().catch(() => ({})).then((out) => {
        if (!res.ok) throw new Error(out.error || `server said ${res.status}`);
      }))
      .catch((e) => {
        throw new Error(e.message === "Failed to fetch" ? "couldn't reach the server" : e.message);
      });
  }

  function setStatus(text) {
    const s = $("record-status");
    s.textContent = text;
    s.hidden = !text;
  }

  // ---------- Result ----------
  function showResult(status) {
    const m = DATA.models[model];
    const scored = rounds.filter((r) => !r.guess);
    const correct = scored.filter((r) => r.correct).length;
    $("score").textContent = correct;
    $("score-of").textContent = "/" + scored.length;
    const avg = scored.length ? Math.round(scored.reduce((a, r) => a + r.readMs, 0) / scored.length / 1000) : 0;
    $("score-line").textContent = `You averaged ${avg} seconds per summary. Each answer scores the prompt that wrote that summary.`;
    const ul = $("breakdown");
    ul.innerHTML = "";
    rounds.forEach((r) => {
      const li = document.createElement("li");
      const left = document.createElement("span");
      const mark = document.createElement("span");
      mark.className = r.correct ? "ok" : "no";
      mark.textContent = r.correct ? "✓ " : "✗ ";
      const link = document.createElement("a");
      link.href = r.article.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = r.article.title;
      left.append(mark, link);
      const meta = document.createElement("span");
      meta.className = "meta";
      const who = (r.tooHard ? "too hard · " : "") + (r.guess ? "guess round" : r.promptId === m.golden.id ? `golden, prompt ${promptName(r.promptId)}` : `challenger, prompt ${promptName(r.promptId)}`);
      meta.textContent = r.guess ? who : `${who} · ${Math.round(r.readMs / 1000)}s`;
      li.append(left, meta);
      ul.appendChild(li);
    });
    setStatus(status);
    show("result");
  }

  $("to-question").addEventListener("click", showQuestion);
  $("submit").addEventListener("click", submitAnswer);
  $("too-hard").addEventListener("click", tooHard);
  $("again").addEventListener("click", () => show("intro"));
})();
