"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

import { addresses, explorers } from "@/lib/config";
import { fmtBps, fmtCompact, shortHex } from "@/lib/format";
import { readMarket } from "@/lib/reads";
import { RECORDED } from "@/lib/recorded";

import { Logo, ThemeToggle, Ticker, useTheme } from "../brand";

import { BlockStrip, CurveCrop, TripCrop } from "./visuals";



/**
 * Drives the depth planes: --mx/--my follow the pointer; --sy is set per .stage as how far that section's
 * centre has scrolled past the viewport's centre (0 when centred, clamped to ±1 viewport). Relative, so a
 * section's foreground sits exactly in place while it's being read, however far down the page it is.
 * Off for reduced motion.
 */
function useDepth(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    let mx = 0;
    let my = 0;
    const paint = () => {
      frame = 0;
      const vh = window.innerHeight;
      for (const stage of el.querySelectorAll<HTMLElement>(".stage")) {
        const r = stage.getBoundingClientRect();
        const sy = Math.max(-vh, Math.min(vh, vh / 2 - (r.top + r.height / 2)));
        stage.style.setProperty("--sy", sy.toFixed(0));
      }
      el.style.setProperty("--mx", mx.toFixed(3));
      el.style.setProperty("--my", my.toFixed(3));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const onMove = (e: PointerEvent) => {
      mx = (e.clientX / window.innerWidth) * 2 - 1;
      my = (e.clientY / window.innerHeight) * 2 - 1;
      schedule();
    };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("pointermove", onMove, { passive: true });
    paint();
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, [ref]);
}

export function Landing() {
  const root = useRef<HTMLDivElement>(null);
  useDepth(root);
  const [theme, cycleTheme] = useTheme();
  const live = useQuery({ queryKey: ["landing-market"], queryFn: readMarket, refetchInterval: 15_000 });
  const m = live.data;

  const ticker: [string, string][] = [
    ["PERP MARK", m ? fmtBps(m.markBps) : "…"],
    ["MARKET", m ? (m.tripped ? "TRIPPED · CLAIMS OPEN" : "ARMED") : "…"],
    ["POOL VALUE", m ? `${fmtCompact(m.poolValue)} tUSD` : "…"],
    ["UTILIZATION", m ? `${((Number(m.utilizationWad) / 1e18) * 100).toFixed(1)}%` : "…"],
    ["10K COVER · 1 DAY", m?.quote != null ? `${(Number(m.quote) / 1e18).toFixed(2)} tUSD` : "…"],
    ["MARK → MARKET", RECORDED.mark.latency],
    ["DRAIN → PAYOUT", RECORDED.trip.latency],
  ];

  return (
    <div ref={root} className="landing" data-theme={theme === "auto" ? undefined : theme}>
      <div className="grain" aria-hidden />

      {/* ------------------------------------------------------------ nav */}
      <header className="relative z-20 mx-auto flex max-w-[1440px] items-center justify-between px-6 py-6 lg:px-12">
        <Logo />
        <div className="flex items-center gap-3 md:hidden">
          <ThemeToggle theme={theme} onToggle={cycleTheme} />
        </div>
        <nav className="hidden items-center gap-8 md:flex">
          <ThemeToggle theme={theme} onToggle={cycleTheme} />
          {[
            ["#products", "Products"],
            ["#trip", "The trip"],
            ["#safeguards", "Safeguards"],
          ].map(([href, label]) => (
            <a key={href} href={href} className="kicker hover:text-[var(--bone)]">
              {label}
            </a>
          ))}
          <Link href="/app" className="btn-ghost !py-2.5">
            Launch app ↗
          </Link>
        </nav>
      </header>

      {/* ------------------------------------------------------------ hero */}
      <section className="stage relative mx-auto max-w-[1440px] px-6 pb-24 pt-8 lg:px-12 lg:pb-36 lg:pt-14">
        <div className="plane-bg pointer-events-none absolute inset-0" aria-hidden>
          <div className="atmos" />
          <div className="grid-field" />
          <div className="form-ring" style={{ width: 760, height: 760, right: -220, top: -180 }} />
          <div className="form-ring" style={{ width: 420, height: 420, right: 40, top: 40, borderStyle: "dashed" }} />
          <div className="form-slab hatch" style={{ width: 360, height: 500, left: "50%", top: 120, transform: "rotate(8deg)", opacity: 0.7 }} />
        </div>

        <div className="relative grid items-center gap-12 lg:grid-cols-12">
          {/* foreground */}
          <div className="plane-fg lg:col-span-7">
            <p className="kicker mb-8 flex items-center gap-3">
              <span className="live-dot" aria-hidden /> Unichain ↔ Base · settled by Reactive Network
            </p>
            <h1 className="display text-[clamp(4.2rem,11.5vw,11.5rem)]">
              Trade
              <br />
              <span className="outline-text">the</span>
              <br />
              gap<span style={{ color: "var(--rift)" }}>.</span>
            </h1>
            <p className="mt-10 max-w-xl text-lg leading-relaxed" style={{ color: "var(--bone-dim)" }}>
              Rift turns the price gap between twin pools on two chains into a market. Trade the spread every second, or
              buy protection that pays out within seconds of a real vault drain. No claims process. No keepers.
            </p>
            <div className="mt-12 flex flex-wrap items-center gap-5">
              <Link href="/app" className="btn-brutal">
                Launch app <span aria-hidden>→</span>
              </Link>
              <a href="#trip" className="btn-ghost">
                Watch a trip ↓
              </a>
            </div>
          </div>

          {/* mid-ground */}
          <div className="relative h-[420px] sm:h-[520px] lg:col-span-5 lg:h-[560px]" style={{ perspective: "1200px" }}>
            <div className="plane-mid absolute inset-0">
              <figure className="frame frame-tilt-r corner-ticks absolute right-0 top-0 w-[88%] overflow-hidden">
                <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: "var(--line-strong)" }}>
                  <span className="kicker">Recorded trip · Unichain</span>
                  <span className="mono text-xs" style={{ color: "var(--rift)" }}>
                    −74.36%
                  </span>
                </div>
                <TripCrop className="block h-auto w-full" />
              </figure>
              <figure className="frame frame-recessed absolute bottom-16 left-0 hidden w-[62%] overflow-hidden sm:block" style={{ background: "var(--ink-3)" }}>
                <CurveCrop className="block h-auto w-full" />
                <figcaption className="kicker border-t px-4 py-2.5" style={{ borderColor: "var(--line-strong)" }}>
                  Base pool · after the dump
                </figcaption>
              </figure>
              <div
                className="frame absolute bottom-6 right-4 w-[54%] px-5 py-4"
                style={{ transform: "translateZ(60px) rotateZ(-2deg)", background: "var(--bone)", color: "var(--ink)" }}
              >
                <div className="mono text-[0.65rem] uppercase tracking-[0.2em] opacity-70">Payout claimed</div>
                <div className="display-tight mt-1 text-4xl">10,000</div>
                <div className="mono mt-1 text-xs opacity-70">tUSD · policy #0 · {shortHex(RECORDED.claim, 4)}</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ live ticker */}
      <Ticker items={ticker} tilt />

      {/* ------------------------------------------------------------ products */}
      <section id="products" className="stage relative mx-auto max-w-[1440px] px-6 py-32 lg:px-12 lg:py-44">
        <div className="plane-bg pointer-events-none absolute inset-0" aria-hidden>
          <div className="dots absolute inset-y-0 right-0 w-1/3 opacity-60" />
          <div className="form-slab" style={{ width: 620, height: 620, left: -160, top: 40, transform: "rotate(-12deg)" }} />
        </div>

        <div className="plane-fg grid gap-6 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <p className="kicker mb-6">01 / Products</p>
            <h2 className="display text-[clamp(3rem,6.5vw,6.5rem)]">
              One
              <br />
              index<span style={{ color: "var(--rift)" }}>.</span>
              <br />
              <span className="outline-text">Two</span>
              <br />
              payoffs.
            </h2>
          </div>
          <p className="max-w-md self-end text-lg leading-relaxed lg:col-span-6 lg:col-start-7" style={{ color: "var(--bone-dim)" }}>
            A drained vault drags its pool&apos;s price away from the twin pool on the other chain. So a drain is just the most extreme
            version of the spread, and one number can price both products, the way credit markets trade spreads and default
            protection side by side.
          </p>
        </div>

        <div className="relative mt-20 grid gap-8 lg:mt-28 lg:grid-cols-2" style={{ perspective: "1600px" }}>
          <ProductCard
            n="02"
            tilt="frame-tilt-l"
            title="Drain protection"
            tag="The jump leg"
            body="Pay a premium for cover on a vault. If it's drained while you're covered, the trip fixes your payout in the same callback, and you claim it. Premiums rise as the pool fills up and when the spread is already stressed."
            stats={[
              ["Cover starts", "10 min after purchase"],
              ["Payout", "Fixed in the trip tx"],
              ["Pricing", "Utilization curve × stress"],
            ]}
          />
          <ProductCard
            n="03"
            tilt="frame-tilt-r"
            offset
            title="Spread perp"
            tag="The continuous leg"
            body="Go long or short the Unichain↔Base spread at up to 10×. Funding accrues every second: longs pay while the spread is positive, shorts while it's negative. On a trip, every position settles at the trip mark."
            stats={[
              ["Leverage", "1–10×"],
              ["Mark", "Time-weighted, ~30 s"],
              ["Counterparty", "The underwriting pool"],
            ]}
          />
        </div>
      </section>

      {/* ------------------------------------------------------------ the trip */}
      <section id="trip" className="stage relative overflow-hidden border-y py-32 lg:py-44" style={{ borderColor: "var(--line)", background: "var(--ink-2)" }}>
        <div className="plane-bg pointer-events-none absolute inset-0" aria-hidden>
          <div className="atmos" style={{ transform: "scaleX(-1)" }} />
          <div className="grid-field" />
        </div>

        <div className="relative mx-auto max-w-[1440px] px-6 lg:px-12">
          <div className="plane-fg flex flex-wrap items-end justify-between gap-8">
            <div>
              <p className="kicker mb-6">04 / The trip</p>
              <h2 className="display text-[clamp(3rem,7vw,7rem)]">
                Drain to
                <br />
                payout<span style={{ color: "var(--rift)" }}>:</span>
              </h2>
            </div>
            <div className="display text-[clamp(6rem,18vw,17rem)]" style={{ color: "var(--rift)", textTransform: "none" }} aria-label="about two seconds">
              ~2s
            </div>
          </div>

          <div className="relative mt-16 grid gap-6 lg:grid-cols-3" style={{ perspective: "1400px" }}>
            {[
              ["Base Sepolia", "Origin", "The vault is drained and the loot is dumped into the pool. The spread breaks.", RECORDED.trip.origin, explorers.base],
              ["Reactive Lasna", "Reaction", "RiftReactive sees both conditions hold and requests the trip callback. No keeper, no bot.", RECORDED.trip.reactive, explorers.lasna],
              ["Unichain Sepolia", "Settlement", "The market fixes every covered payout and freezes the perp at the trip mark.", RECORDED.trip.callback, explorers.unichain],
            ].map(([chain, step, text, hash, base], i) => (
              <article
                key={chain}
                className="frame corner-ticks p-7"
                style={{
                  transform: `translateZ(${-i * 70}px) translateY(${i * 28}px)`,
                  background: i === 2 ? "var(--bone)" : "var(--ink-3)",
                  color: i === 2 ? "var(--ink)" : "var(--bone)",
                } as CSSProperties}
              >
                <div className="mono flex justify-between text-xs uppercase tracking-[0.18em] opacity-70">
                  <span>0{i + 1} · {step}</span>
                  <span>{chain}</span>
                </div>
                <p className="display-tight mt-8 text-3xl">{step}</p>
                <p className="mt-4 text-sm leading-relaxed opacity-80">{text}</p>
                <a href={`${base}/tx/${hash}`} target="_blank" rel="noreferrer" className="mono mt-8 inline-block text-xs underline underline-offset-4 opacity-80 hover:opacity-100">
                  {shortHex(hash, 6)} ↗
                </a>
              </article>
            ))}
          </div>

          <figure className="frame hatch mt-20 overflow-hidden px-6 py-6 lg:w-2/3" style={{ background: "var(--ink)" }}>
            <BlockStrip className="block h-auto w-full max-w-3xl" />
            <figcaption className="kicker mt-3">One event per chain. Each step is a real testnet transaction, linked above.</figcaption>
          </figure>
        </div>
      </section>

      {/* ------------------------------------------------------------ the rule */}
      <section className="stage relative mx-auto max-w-[1440px] px-6 py-32 lg:px-12 lg:py-44">
        <div className="plane-bg pointer-events-none absolute inset-0" aria-hidden>
          <div className="form-ring" style={{ width: 900, height: 900, left: "30%", top: -200 }} />
        </div>
        <div className="plane-fg grid gap-16 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <p className="kicker mb-6">05 / The rule</p>
            <h2 className="display-tight text-[clamp(2.4rem,4vw,4rem)]">Two conditions, or nothing.</h2>
            <p className="mt-8 text-lg leading-relaxed" style={{ color: "var(--bone-dim)" }}>
              Someone could push a thin pool to fake a crash and collect on cover they bought. So a price spike alone can&apos;t trip
              Rift, and neither can a big legitimate withdrawal. It takes both, measured on Reactive&apos;s own clock.
            </p>
          </div>
          <div className="relative lg:col-span-8">
            <RuleRow big="5%" unit="× 2s" label="The spread breaks past 5% and stays broken for 2 seconds." />
            <div className="my-2 flex items-center gap-6">
              <span className="display text-6xl" style={{ color: "var(--rift)" }}>
                +
              </span>
              <span className="h-px flex-1" style={{ background: "var(--line-strong)" }} />
            </div>
            <RuleRow big="15%" unit="/ 5m" label="And at least 15% of the vault flows out within 5 minutes." />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ safeguards */}
      <section id="safeguards" className="relative border-t py-32 lg:py-40" style={{ borderColor: "var(--line)" }}>
        <div className="mx-auto max-w-[1440px] px-6 lg:px-12">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <h2 className="display text-[clamp(3rem,7vw,7rem)]">
              Built to be
              <br />
              <span className="outline-text">attacked.</span>
            </h2>
            <p className="kicker max-w-xs">06 / Safeguards · each one has a test that fails without it</p>
          </div>
          <div className="mt-16 grid border-l border-t sm:grid-cols-2 lg:grid-cols-4" style={{ borderColor: "var(--line-strong)" }}>
            {[
              ["Cover delay", "Cover bought after a drain is already visible doesn't pay. It gets its premium back."],
              ["Claim-based payouts", "One buyer who can't receive tokens can't block everyone else's payout."],
              ["Trip confirmation", "RiftReactive resends the trip until it sees the market's own Tripped event."],
              ["Time-weighted mark", "A price pushed and put back within a second moves the perp mark by zero."],
              ["Liveness guard", "If marks stop arriving, the market stops selling cover it couldn't pay out."],
              ["Utilization pricing", "Cover costs ~16× more for the last slice of the pool than the first."],
              ["Delayed withdrawals", "Underwriters can't see a drain coming and get out before the trip lands."],
              ["Fair share price", "Deposits and withdrawals are priced with traders' open PnL included."],
            ].map(([title, text], i) => (
              <div
                key={title}
                className={`group relative border-b border-r p-7 transition-colors ${i % 3 === 0 ? "hatch" : ""}`}
                style={{ borderColor: "var(--line-strong)" }}
              >
                <span className="mono text-xs" style={{ color: "var(--rift)" }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="display-tight mt-6 text-xl">{title}</h3>
                <p className="mt-3 text-sm leading-relaxed" style={{ color: "var(--bone-dim)" }}>
                  {text}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ closing CTA */}
      <section className="stage relative overflow-hidden py-36 lg:py-48">
        <div className="plane-bg pointer-events-none absolute inset-0" aria-hidden>
          <div className="atmos" />
          <div className="form-slab" style={{ width: 520, height: 520, right: "8%", top: 30, transform: "rotate(18deg)" }} />
          <div className="form-slab hatch" style={{ width: 340, height: 340, right: "14%", top: 120, transform: "rotate(30deg)" }} />
        </div>
        <div className="plane-fg relative mx-auto max-w-[1440px] px-6 lg:px-12">
          <h2 className="display text-[clamp(4rem,13vw,13rem)]">
            Mind
            <br />
            the <span style={{ color: "var(--rift)" }}>gap</span>.
          </h2>
          <div className="mt-14 flex flex-wrap items-center gap-6">
            <Link href="/app" className="btn-brutal">
              Open the app <span aria-hidden>→</span>
            </Link>
            <a href={`${explorers.unichain}/address/${addresses.unichain.market}`} target="_blank" rel="noreferrer" className="btn-ghost">
              RiftMarket on Uniscan ↗
            </a>
          </div>
        </div>
      </section>

      <footer className="border-t" style={{ borderColor: "var(--line)" }}>
        <div className="kicker mx-auto flex max-w-[1440px] flex-wrap justify-between gap-4 px-6 py-8 lg:px-12">
          <span>Rift · testnet demo on Base Sepolia, Unichain Sepolia and Reactive Lasna</span>
          <span>Live figures read from chain every 15 s</span>
        </div>
      </footer>
    </div>
  );
}

function ProductCard({
  n,
  title,
  tag,
  body,
  stats,
  tilt,
  offset,
}: {
  n: string;
  title: string;
  tag: string;
  body: string;
  stats: [string, string][];
  tilt: string;
  offset?: boolean;
}) {
  return (
    <article className={`frame corner-ticks ${tilt} p-8 lg:p-10 ${offset ? "lg:mt-24" : ""}`} style={{ background: "var(--ink-2)" }}>
      <div className="flex items-start justify-between">
        <span className="kicker">{tag}</span>
        <span className="display text-6xl opacity-15">{n}</span>
      </div>
      <h3 className="display-tight mt-6 text-[clamp(2rem,3.4vw,3.2rem)]">{title}</h3>
      <p className="mt-6 leading-relaxed" style={{ color: "var(--bone-dim)" }}>
        {body}
      </p>
      <dl className="mt-10 grid grid-cols-1 border-t sm:grid-cols-3" style={{ borderColor: "var(--line-strong)" }}>
        {stats.map(([k, v]) => (
          <div key={k} className="border-b py-4 sm:border-b-0 sm:pr-4" style={{ borderColor: "var(--line)" }}>
            <dt className="kicker !text-[0.62rem]">{k}</dt>
            <dd className="mt-2 text-sm">{v}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function RuleRow({ big, unit, label }: { big: string; unit: string; label: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
      <span className="display text-[clamp(6rem,15vw,14rem)]">{big}</span>
      <span className="display-tight pb-4 text-[clamp(2rem,4vw,3.6rem)]" style={{ color: "var(--bone-dim)", textTransform: "none" }}>
        {unit}
      </span>
      <p className="w-full max-w-md pb-2 text-base" style={{ color: "var(--bone-dim)" }}>
        {label}
      </p>
    </div>
  );
}
