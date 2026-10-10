<!--
  Clawd, the pixel tutor in glasses. Drawn on a 16×16 grid; every mood is CSS animation.
  Motion uses squash and stretch from the feet: legs stay planted, the torso breathes, tilts and
  bounces. Changing mood plays a short pop, and poking Clawd makes it boing.
  `animate={false}` freezes it (used for older messages in the thread).
-->
<script lang="ts">
  import type { Mood } from "../lib/api";

  let {
    mood = "idle",
    size = 120,
    animate = true,
    follow = true,
    onpoke,
  }: {
    mood?: Mood;
    size?: number;
    animate?: boolean;
    follow?: boolean;
    onpoke?: () => void;
  } = $props();

  let el = $state<SVGSVGElement>();
  let lx = $state(0);
  let ly = $state(0);
  // Alternates between two identical animations so repeated pokes restart the boing.
  let boing = $state<"" | "a" | "b">("");
  let boingTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if (!follow || !animate) return;
    // Eyes that track the cursor are motion too.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const move = (e: PointerEvent) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const len = Math.max(1, Math.hypot(dx, dy));
      const k = Math.min(1, len / 160);
      lx = (dx / len) * k;
      ly = (dy / len) * k;
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  });

  $effect(() => () => clearTimeout(boingTimer));

  function poke() {
    if (!onpoke) return;
    boing = boing === "a" ? "b" : "a";
    clearTimeout(boingTimer);
    boingTimer = setTimeout(() => (boing = ""), 600);
    onpoke();
  }

  const confetti = Array.from({ length: 18 }, (_, i) => ({
    x: ((i * 7.3) % 17) - 0.5,
    delay: -((i * 0.37) % 2.2),
    dur: 1.8 + ((i * 0.53) % 1.2),
    color: ["#d97757", "#f2c94c", "#6aa7f0", "#74c48f", "#f28bb8"][i % 5],
    w: 0.35 + (i % 3) * 0.1,
    alt: i % 2 === 1,
  }));

  const eyesOpen = $derived(!["happy", "celebrating", "sleepy"].includes(mood));
  const lookX = $derived(mood === "thinking" ? 0.3 : eyesOpen ? lx * 0.35 : 0);
  const lookY = $derived(mood === "thinking" ? -0.35 : eyesOpen ? ly * 0.3 : 0);
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<svg
  bind:this={el}
  class="clawd mood-{mood}"
  class:still={!animate}
  class:pokeable={!!onpoke}
  viewBox="-1 -1 18 17.4"
  width={size}
  height={size}
  role={onpoke ? "button" : "img"}
  tabindex={onpoke ? 0 : undefined}
  onclick={poke}
  onkeydown={(e) => onpoke && (e.key === "Enter" || e.key === " ") && poke()}
>
  <!-- Named by a title, not aria-label: Obsidian gives anything with an aria-label its own
       tooltip, which only works on HTML elements and throws on an SVG. -->
  <title>{onpoke ? "Poke Clawd" : `Clawd is ${mood}`}</title>
  <defs>
    <clipPath id="lenses-{size}">
      <rect x="3.9" y="7.55" width="3.2" height="2.9" rx="0.5" />
      <rect x="8.9" y="7.55" width="3.2" height="2.9" rx="0.5" />
    </clipPath>
  </defs>

  <ellipse class="shadow" cx="8" cy="15.4" rx="5.5" ry="0.45" />

  {#key mood}
    <g class="enter">
      <g class="boing" class:boing-a={boing === "a"} class:boing-b={boing === "b"}>
        <g class="figure">
          <g class="legs">
            <rect x="4" y="13" width="1" height="2" />
            <rect x="6" y="13" width="1" height="2" />
            <rect x="9" y="13" width="1" height="2" />
            <rect x="11" y="13" width="1" height="2" />
          </g>

          <g class="torso">
            {#if mood === "celebrating"}
              <rect class="arm up-l" x="1" y="5.5" width="2" height="3" />
              <rect class="arm up-r" x="13" y="5.5" width="2" height="3" />
            {:else if mood === "encouraging"}
              <rect class="arm" x="1" y="9" width="2" height="2" />
              <rect class="arm wave" x="13" y="5.5" width="2" height="3" />
            {:else if mood === "thinking"}
              <rect class="arm" x="1" y="9" width="2" height="2" />
              <rect class="arm chin" x="13" y="8" width="2" height="1.5" />
            {:else if mood === "concerned" || mood === "sleepy"}
              <rect class="arm" x="1.5" y="10" width="1.5" height="2" />
              <rect class="arm" x="13" y="10" width="1.5" height="2" />
            {:else if mood === "happy"}
              <rect class="arm swing-l" x="1" y="9" width="2" height="2" />
              <rect class="arm swing-r" x="13" y="9" width="2" height="2" />
            {:else}
              <rect class="arm" x="1" y="9" width="2" height="2" />
              <rect class="arm" x="13" y="9" width="2" height="2" />
            {/if}

            <rect class="body" x="3" y="6" width="10" height="7" />

            {#if mood === "concerned"}
              <path class="brow" d="M4.3 7.1 L6.6 6.5 M9.4 6.5 L11.7 7.1" />
            {:else if mood === "confused"}
              <path class="brow raise" d="M4.3 6.4 L6.6 6.6 M9.4 7.1 L11.7 7" />
            {:else if mood === "proud"}
              <path class="brow" d="M4.3 6.7 L6.6 7 M9.4 7 L11.7 6.7" />
            {/if}

            <g class="glasses">
              <rect class="lens" x="3.9" y="7.55" width="3.2" height="2.9" rx="0.5" />
              <rect class="lens" x="8.9" y="7.55" width="3.2" height="2.9" rx="0.5" />

              <g class="eyes" style="transform: translate({lookX}px, {lookY}px)">
                <g class="look">
                  {#if mood === "happy" || mood === "celebrating"}
                    <path class="caret" d="M4.9 9.35 L5.5 8.65 L6.1 9.35 M9.9 9.35 L10.5 8.65 L11.1 9.35" />
                  {:else if mood === "sleepy"}
                    <path class="caret" d="M4.9 9.3 H6.1 M9.9 9.3 H11.1" />
                  {:else if mood === "encouraging"}
                    <rect class="eye blink" x="5" y="8.15" width="1" height="1.7" />
                    <path class="caret" d="M9.9 9.35 L10.5 8.65 L11.1 9.35" />
                  {:else if mood === "proud"}
                    <rect class="eye" x="5" y="8.95" width="1" height="0.8" />
                    <rect class="eye" x="10" y="8.95" width="1" height="0.8" />
                  {:else if mood === "concerned"}
                    <rect class="eye blink" x="5.1" y="8.4" width="0.8" height="1.2" />
                    <rect class="eye blink" x="10.1" y="8.4" width="0.8" height="1.2" />
                  {:else if mood === "curious"}
                    <rect class="eye blink" x="4.9" y="8" width="1.2" height="2" />
                    <rect class="eye blink" x="9.9" y="8" width="1.2" height="2" />
                  {:else if mood === "confused"}
                    <rect class="eye" x="4.9" y="8" width="1.2" height="2" />
                    <rect class="eye" x="10.15" y="8.5" width="0.7" height="1" />
                  {:else}
                    <rect class="eye blink" x="5" y="8.15" width="1" height="1.7" />
                    <rect class="eye blink" x="10" y="8.15" width="1" height="1.7" />
                  {/if}
                </g>
              </g>

              <rect class="frame" x="3.9" y="7.55" width="3.2" height="2.9" rx="0.5" />
              <rect class="frame" x="8.9" y="7.55" width="3.2" height="2.9" rx="0.5" />
              <path class="frame" d="M7.1 8.5 H8.9 M3.9 8.5 L3 8 M12.1 8.5 L13 8" />

              {#if mood === "proud"}
                <g clip-path="url(#lenses-{size})">
                  <path class="glint" d="M3 10.6 L4.4 7.4" />
                </g>
              {/if}
            </g>
          </g>
        </g>
      </g>
    </g>

    <!-- Mood effects -->
    {#if mood === "thinking"}
      <g class="fx thought">
        <circle cx="13.4" cy="5.6" r="0.3" />
        <circle cx="14.3" cy="4.2" r="0.45" />
        <circle cx="15" cy="2.4" r="0.7" />
      </g>
    {:else if mood === "curious"}
      <text class="fx q pop" x="13.6" y="4.6" font-size="3.2">?</text>
    {:else if mood === "confused"}
      <text class="fx q pop" x="13" y="4.4" font-size="3">?</text>
      <text class="fx q pop q2" x="2.2" y="4.8" font-size="2">?</text>
    {:else if mood === "concerned"}
      <path class="fx drop" d="M13.4 5.3 Q13.05 6 13.05 6.25 A0.37 0.37 0 0 0 13.79 6.25 Q13.79 6 13.4 5.3 Z" />
    {:else if mood === "sleepy"}
      <g class="fx zzz">
        <text x="12" y="6" font-size="1.4">z</text>
        <text x="12" y="6" font-size="1.4">z</text>
        <text x="12" y="6" font-size="1.4">z</text>
      </g>
    {:else if mood === "happy" || mood === "encouraging" || mood === "proud"}
      <g class="fx sparkles">
        <path d="M1.5 3.2 L1.75 3.75 L2.3 4 L1.75 4.25 L1.5 4.8 L1.25 4.25 L0.7 4 L1.25 3.75 Z" />
        <path d="M14.5 2.7 L14.75 3.25 L15.3 3.5 L14.75 3.75 L14.5 4.3 L14.25 3.75 L13.7 3.5 L14.25 3.25 Z" />
      </g>
    {:else if mood === "celebrating"}
      <g class="fx confetti">
        {#each confetti as c}
          <rect
            class:alt={c.alt}
            x={c.x}
            y="-1"
            width={c.w}
            height="0.55"
            fill={c.color}
            style="animation-delay: {c.delay}s; animation-duration: {c.dur}s"
          />
        {/each}
      </g>
    {/if}
  {/key}
</svg>

<style>
  .clawd {
    display: block;
    overflow: visible;
    flex: none;
  }
  .pokeable {
    cursor: pointer;
  }
  .body,
  .arm {
    fill: #d97757;
  }
  .legs rect {
    fill: #b55c40;
  }
  .lens {
    fill: rgba(255, 255, 255, 0.13);
  }
  .eye {
    fill: #1e1816;
  }
  .caret {
    fill: none;
    stroke: #1e1816;
    stroke-width: 0.32;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .frame {
    fill: none;
    stroke: #1c1c22;
    stroke-width: 0.32;
    stroke-linecap: round;
  }
  .brow {
    fill: none;
    stroke: #b55c40;
    stroke-width: 0.3;
    stroke-linecap: round;
  }
  .shadow {
    fill: rgba(0, 0, 0, 0.18);
  }
  .glint {
    stroke: rgba(255, 255, 255, 0.85);
    stroke-width: 0.45;
    animation: glint 2.4s ease-in-out infinite;
  }
  .fx {
    fill: var(--clawd-fx);
  }
  .fx text {
    font-family: var(--font-ui);
    font-weight: 700;
  }
  .drop {
    fill: #78beff;
  }
  .sparkles path {
    fill: #f2c94c;
  }
  .eyes {
    transition: transform 0.12s ease-out;
  }

  /* Everything that squashes, tilts or pops does so from its own base. */
  .shadow,
  .enter,
  .boing,
  .figure,
  .torso,
  .arm,
  .blink,
  .brow,
  .fx text,
  .sparkles path,
  .thought circle,
  .confetti rect,
  .drop {
    transform-box: fill-box;
    transform-origin: 50% 100%;
  }
  .blink,
  .sparkles path,
  .thought circle,
  .confetti rect,
  .drop {
    transform-origin: center;
  }

  /* Mood change: a little pop. Poke: a bigger boing. */
  .enter {
    animation: pop 0.45s cubic-bezier(0.3, 1.4, 0.5, 1);
  }
  .boing-a {
    animation: boing-a 0.55s ease-out;
  }
  .boing-b {
    animation: boing-b 0.55s ease-out;
  }

  /* Idle: breathe, blink now and then, glance around. */
  .torso {
    animation: breathe 3.2s ease-in-out infinite;
  }
  .blink {
    animation: blink 7s infinite;
  }
  .mood-idle .look,
  .mood-curious .look {
    animation: glance 9s ease-in-out infinite;
  }

  /* Happy: hop with squash and stretch, arms swinging. */
  .mood-happy .figure {
    animation: hop 0.75s ease-in-out infinite;
  }
  .mood-happy .shadow {
    animation: hop-shadow 0.75s ease-in-out infinite;
  }
  .mood-happy .torso {
    animation: none;
  }
  .swing-l,
  .swing-r {
    transform-origin: 50% 0;
    animation: swing 0.375s ease-in-out infinite alternate;
  }
  .swing-r {
    animation-direction: alternate-reverse;
  }

  /* Celebrating: big jumps, arms pumping, confetti fluttering down. */
  .mood-celebrating .figure {
    animation: jump 0.7s ease-in-out infinite;
  }
  .mood-celebrating .shadow {
    animation: jump-shadow 0.7s ease-in-out infinite;
  }
  .mood-celebrating .torso {
    animation: none;
  }
  .up-l,
  .up-r {
    animation: pump 0.35s ease-in-out infinite alternate;
  }
  .up-r {
    animation-direction: alternate-reverse;
  }
  .confetti rect {
    animation: flutter 2s linear infinite;
  }
  .confetti rect.alt {
    animation-name: flutter-alt;
  }

  /* Thinking: hand on chin, tapping; thoughts drift up. */
  .mood-thinking .torso {
    animation: ponder 4s ease-in-out infinite;
  }
  .chin {
    animation: tap 1.2s ease-in-out infinite;
  }
  .thought circle {
    opacity: 0;
    animation: thought 2.4s ease-out infinite;
  }
  .thought circle:nth-child(2) {
    animation-delay: 0.3s;
  }
  .thought circle:nth-child(3) {
    animation-delay: 0.6s;
  }

  /* Encouraging: a proper wave with overshoot, leaning into it. */
  .mood-encouraging .torso {
    animation: lean 1.4s ease-in-out infinite;
  }
  .wave {
    transform-origin: 30% 100%;
    animation: wave 1.4s cubic-bezier(0.45, 0, 0.3, 1.3) infinite;
  }

  /* Concerned: still, then a nervous fidget; eyes dart; sweat slides down. */
  .mood-concerned .figure {
    animation: fidget 2.6s ease-in-out infinite;
  }
  .mood-concerned .look {
    animation: dart 2.6s steps(1) infinite;
  }
  .drop {
    animation: sweat 2.6s ease-in infinite;
  }

  /* Curious: head tilts one way, then the other; the question mark pops. */
  .mood-curious .figure {
    animation: tilt 3.6s ease-in-out infinite;
  }
  .q.pop {
    animation: q-pop 3.6s cubic-bezier(0.3, 1.5, 0.5, 1) infinite;
  }

  /* Confused: tilts back and forth with a pause; brow twitches; two question marks take turns. */
  .mood-confused .figure {
    animation: puzzle 3s ease-in-out infinite;
  }
  .mood-confused .q.pop {
    animation-duration: 3s;
  }
  .q2.pop {
    animation-delay: -1.5s;
  }
  .raise {
    animation: twitch 3s ease-in-out infinite;
  }

  /* Proud: chest puffed, glint across the lenses, sparkles. */
  .mood-proud .torso {
    animation: puff 2.4s ease-in-out infinite;
  }
  .sparkles path {
    animation: twinkle 1.8s ease-in-out infinite;
  }
  .sparkles path:nth-child(2) {
    animation-delay: -0.9s;
  }

  /* Sleepy: slow breaths, head drooping, then a jolt awake; z's drift up. */
  .mood-sleepy .torso {
    animation: doze 6s ease-in infinite;
  }
  .mood-sleepy .glasses {
    transform: translateY(0.5px);
  }
  .zzz text {
    opacity: 0;
    transform-origin: 0 100%;
    animation: zz 3.6s ease-out infinite;
  }
  .zzz text:nth-child(2) {
    animation-delay: 1.2s;
  }
  .zzz text:nth-child(3) {
    animation-delay: 2.4s;
  }

  .still *,
  .still {
    animation: none !important;
  }
  .still .thought circle,
  .still .zzz text,
  .still .q {
    opacity: 1;
  }
  @media (prefers-reduced-motion: reduce) {
    .clawd *,
    .clawd {
      animation: none !important;
    }
    .thought circle,
    .zzz text,
    .q {
      opacity: 1;
    }
  }

  @keyframes pop {
    0% {
      transform: scale(1.12, 0.86);
    }
    45% {
      transform: scale(0.95, 1.06);
    }
    75% {
      transform: scale(1.02, 0.98);
    }
    100% {
      transform: none;
    }
  }
  @keyframes boing-a {
    0% {
      transform: scale(1.18, 0.78);
    }
    30% {
      transform: scale(0.88, 1.14) translateY(-0.6px);
    }
    55% {
      transform: scale(1.06, 0.95);
    }
    80% {
      transform: scale(0.98, 1.02);
    }
    100% {
      transform: none;
    }
  }
  @keyframes boing-b {
    0% {
      transform: scale(1.18, 0.78);
    }
    30% {
      transform: scale(0.88, 1.14) translateY(-0.6px);
    }
    55% {
      transform: scale(1.06, 0.95);
    }
    80% {
      transform: scale(0.98, 1.02);
    }
    100% {
      transform: none;
    }
  }
  @keyframes breathe {
    50% {
      transform: scale(1.015, 1.035);
    }
  }
  @keyframes blink {
    0%,
    30%,
    33%,
    86%,
    89%,
    92%,
    100% {
      transform: scaleY(1);
    }
    31.5%,
    87.5%,
    90.5% {
      transform: scaleY(0.1);
    }
  }
  @keyframes glance {
    0%,
    38%,
    82%,
    100% {
      transform: translate(0, 0);
    }
    42%,
    55% {
      transform: translate(-0.35px, 0.05px);
    }
    60%,
    76% {
      transform: translate(0.35px, -0.1px);
    }
  }
  @keyframes hop {
    0%,
    100% {
      transform: translateY(0) scale(1.1, 0.88);
    }
    15% {
      transform: translateY(0) scale(1, 1);
    }
    25% {
      transform: translateY(-0.5px) scale(0.93, 1.08);
    }
    50% {
      transform: translateY(-1.3px) scale(1, 1);
    }
    80% {
      transform: translateY(-0.3px) scale(0.96, 1.05);
    }
  }
  @keyframes hop-shadow {
    0%,
    100% {
      transform: scaleX(1.06);
    }
    50% {
      transform: scaleX(0.7);
      opacity: 0.55;
    }
  }
  @keyframes swing {
    from {
      transform: rotate(-12deg);
    }
    to {
      transform: rotate(12deg);
    }
  }
  @keyframes jump {
    0%,
    100% {
      transform: translateY(0) scale(1.14, 0.84);
    }
    14% {
      transform: translateY(0) scale(1, 1);
    }
    24% {
      transform: translateY(-0.9px) scale(0.9, 1.12);
    }
    50% {
      transform: translateY(-2.6px) scale(1, 1);
    }
    82% {
      transform: translateY(-0.5px) scale(0.94, 1.08);
    }
  }
  @keyframes jump-shadow {
    0%,
    100% {
      transform: scaleX(1.1);
    }
    50% {
      transform: scaleX(0.55);
      opacity: 0.45;
    }
  }
  @keyframes pump {
    from {
      transform: translateY(0.2px) rotate(-6deg);
    }
    to {
      transform: translateY(-0.6px) rotate(10deg);
    }
  }
  @keyframes flutter {
    0% {
      transform: translate(0, -1px) rotate(0deg);
    }
    25% {
      transform: translate(0.45px, 3.5px) rotate(140deg) scaleX(0.4);
    }
    50% {
      transform: translate(-0.35px, 8px) rotate(270deg);
    }
    75% {
      transform: translate(0.4px, 12.5px) rotate(410deg) scaleX(0.4);
    }
    100% {
      transform: translate(0, 17px) rotate(540deg);
    }
  }
  @keyframes flutter-alt {
    0% {
      transform: translate(0, -1px) rotate(0deg);
    }
    25% {
      transform: translate(-0.45px, 3.5px) rotate(-140deg) scaleX(0.4);
    }
    50% {
      transform: translate(0.35px, 8px) rotate(-270deg);
    }
    75% {
      transform: translate(-0.4px, 12.5px) rotate(-410deg) scaleX(0.4);
    }
    100% {
      transform: translate(0, 17px) rotate(-540deg);
    }
  }
  @keyframes ponder {
    0%,
    100% {
      transform: rotate(0deg);
    }
    50% {
      transform: rotate(2.5deg) translateY(-0.1px);
    }
  }
  @keyframes tap {
    0%,
    40%,
    100% {
      transform: translateY(0);
    }
    20%,
    60% {
      transform: translateY(-0.3px);
    }
  }
  @keyframes thought {
    0% {
      opacity: 0;
      transform: translateY(0.4px) scale(0.3);
    }
    25% {
      opacity: 0.85;
      transform: translateY(0) scale(1.1);
    }
    35%,
    75% {
      opacity: 0.85;
      transform: translateY(-0.2px) scale(1);
    }
    100% {
      opacity: 0;
      transform: translateY(-0.7px) scale(1);
    }
  }
  @keyframes lean {
    0%,
    100% {
      transform: rotate(0deg);
    }
    50% {
      transform: rotate(2deg);
    }
  }
  @keyframes wave {
    0%,
    100% {
      transform: rotate(-14deg);
    }
    25% {
      transform: rotate(16deg);
    }
    50% {
      transform: rotate(-12deg);
    }
    75% {
      transform: rotate(16deg);
    }
  }
  @keyframes fidget {
    0%,
    60%,
    100% {
      transform: translateX(0);
    }
    64% {
      transform: translateX(-0.15px);
    }
    68% {
      transform: translateX(0.15px);
    }
    72% {
      transform: translateX(-0.1px);
    }
    76% {
      transform: translateX(0);
    }
  }
  @keyframes dart {
    0% {
      transform: translateX(0);
    }
    30% {
      transform: translateX(-0.3px);
    }
    50% {
      transform: translateX(0.3px);
    }
    70% {
      transform: translateX(0);
    }
  }
  @keyframes sweat {
    0% {
      transform: translate(0, -0.3px) scale(0.4);
      opacity: 0;
    }
    20% {
      transform: translate(0, 0) scale(1);
      opacity: 1;
    }
    70% {
      transform: translate(-0.1px, 1.6px) scale(1);
      opacity: 1;
    }
    100% {
      transform: translate(-0.1px, 3px) scale(0.8);
      opacity: 0;
    }
  }
  @keyframes tilt {
    0%,
    100% {
      transform: rotate(0deg);
    }
    15%,
    42% {
      transform: rotate(-6deg);
    }
    58%,
    85% {
      transform: rotate(4deg);
    }
  }
  @keyframes q-pop {
    0% {
      opacity: 0;
      transform: scale(0.2) rotate(-20deg);
    }
    12% {
      opacity: 1;
      transform: scale(1) rotate(0deg);
    }
    45% {
      opacity: 1;
      transform: translateY(-0.3px) rotate(8deg);
    }
    80% {
      opacity: 1;
      transform: translateY(0) rotate(0deg);
    }
    100% {
      opacity: 0;
      transform: translateY(-0.6px) scale(0.8);
    }
  }
  @keyframes puzzle {
    0%,
    100% {
      transform: rotate(0deg);
    }
    10%,
    35% {
      transform: rotate(5deg);
    }
    50% {
      transform: rotate(0deg);
    }
    60%,
    85% {
      transform: rotate(-5deg);
    }
  }
  @keyframes twitch {
    0%,
    40%,
    50%,
    100% {
      transform: translateY(0);
    }
    44%,
    46% {
      transform: translateY(-0.25px);
    }
  }
  @keyframes puff {
    0%,
    100% {
      transform: scale(1, 1);
    }
    40%,
    70% {
      transform: scale(1.05, 1.03) translateY(-0.15px);
    }
  }
  @keyframes twinkle {
    0%,
    100% {
      transform: scale(1) rotate(0deg);
    }
    50% {
      transform: scale(0.35) rotate(45deg);
      opacity: 0.3;
    }
  }
  @keyframes glint {
    0% {
      transform: translateX(0);
    }
    45%,
    100% {
      transform: translateX(10px);
    }
  }
  @keyframes doze {
    0% {
      transform: rotate(0deg) translateY(0);
    }
    80% {
      transform: rotate(3deg) translateY(0.4px) scale(1.02, 0.97);
    }
    84% {
      transform: rotate(3.5deg) translateY(0.5px) scale(1.02, 0.96);
    }
    88% {
      transform: rotate(-1deg) translateY(-0.2px) scale(0.98, 1.03);
    }
    100% {
      transform: rotate(0deg) translateY(0);
    }
  }
  @keyframes zz {
    0% {
      transform: translate(0, 0) scale(0.8);
      opacity: 0;
    }
    15% {
      opacity: 0.9;
    }
    40% {
      transform: translate(1.6px, -2px) scale(1.2);
    }
    70% {
      transform: translate(2.2px, -4px) scale(1.6);
      opacity: 0.6;
    }
    100% {
      transform: translate(3.8px, -5.8px) scale(1.9);
      opacity: 0;
    }
  }
</style>
