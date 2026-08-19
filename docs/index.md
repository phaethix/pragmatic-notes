---
layout: home
hero:
  text: 技术实践与日常思考
  tagline: 一个务实、简洁的个人博客。
---

<section class="home-timeline" aria-labelledby="timeline-title">
<div class="timeline-heading">
<p class="eyebrow">记录时间线</p>
<h2 id="timeline-title">从一个能用的博客开始</h2>
<p class="timeline-lead">先写下来，再慢慢整理。这里记录真实的问题、实际的做法，以及值得留下来的判断。</p>
</div>

<div class="timeline-list">
<article class="timeline-item timeline-item-current">
<div class="timeline-date">2026.08.19</div>
<div class="timeline-card">
<p class="timeline-label">技术实践 · 第一篇</p>
<h3><a href="./posts/technical/first-note">从一个能用的博客开始</a></h3>
<p>记录 pragmatic-notes 的起点，以及这个博客想解决的问题。</p>
</div>
</article>

<article class="timeline-item">
<div class="timeline-date">持续更新</div>
<div class="timeline-card">
<p class="timeline-label">技术实践</p>
<h3><a href="./posts/technical/">软件工程与开发工具</a></h3>
<p>记录软件工程、AI Agent 和开发工具中的实际问题与解决过程。</p>
</div>
</article>

<article class="timeline-item">
<div class="timeline-date">慢慢积累</div>
<div class="timeline-card">
<p class="timeline-label">日常思考</p>
<h3><a href="./posts/thoughts/">工作方法与个人判断</a></h3>
<p>不急着填满栏目，等真实的内容自然长出来。</p>
</div>
</article>
</div>
</section>

<style>
.VPHome .VPHero {
  margin: 0 auto;
  padding-top: 112px;
  padding-bottom: 72px;
  text-align: center;
}

.VPHome .VPHero .container,
.VPHome .VPHero .main {
  margin: 0 auto;
}

.VPHome .VPHero .name,
.VPHome .VPHero .text,
.VPHome .VPHero .tagline {
  margin-left: auto;
  margin-right: auto;
}

.home-timeline {
  width: min(720px, calc(100% - 48px));
  margin: 0 auto;
  padding: 0 0 96px;
}

.timeline-heading {
  margin-bottom: 44px;
  text-align: center;
}

.timeline-heading .eyebrow {
  margin: 0 0 12px;
  color: var(--vp-c-brand-1);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.timeline-heading h2 {
  margin: 0;
  border: 0;
  padding: 0;
  font-size: 28px;
  letter-spacing: -0.03em;
}

.timeline-lead {
  max-width: 720px;
  margin: 16px auto 0;
  color: var(--vp-c-text-2);
  line-height: 1.8;
}

.timeline-list {
  position: relative;
  padding-left: 112px;
}

.timeline-list::before {
  position: absolute;
  top: 10px;
  bottom: 16px;
  left: 91px;
  width: 1px;
  background: var(--vp-c-divider);
  content: '';
}

.timeline-item {
  position: relative;
  padding-bottom: 30px;
}

.timeline-item::before {
  position: absolute;
  top: 7px;
  left: -25px;
  width: 9px;
  height: 9px;
  border: 2px solid var(--vp-c-bg);
  border-radius: 50%;
  background: var(--vp-c-text-3);
  box-shadow: 0 0 0 1px var(--vp-c-divider);
  content: '';
}

.timeline-item-current::before {
  background: var(--vp-c-brand-1);
  box-shadow: 0 0 0 1px var(--vp-c-brand-1);
}

.timeline-date {
  position: absolute;
  top: 0;
  left: -112px;
  width: 78px;
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  line-height: 1.4;
  text-align: right;
}

.timeline-card {
  padding: 0 0 2px;
}

.timeline-label {
  margin: 0 0 8px;
  color: var(--vp-c-text-3);
  font-size: 12px;
}

.timeline-card h3 {
  margin: 0;
  font-size: 18px;
  letter-spacing: -0.015em;
}

.timeline-card h3 a {
  color: var(--vp-c-text-1);
  text-decoration: none;
}

.timeline-card h3 a:hover {
  color: var(--vp-c-brand-1);
}

.timeline-card > p:last-child {
  margin: 8px 0 0;
  color: var(--vp-c-text-2);
  font-size: 14px;
  line-height: 1.75;
}

@media (max-width: 640px) {
  .VPHome .VPHero {
    padding-top: 72px;
    padding-bottom: 56px;
  }

  .home-timeline {
    width: min(100% - 32px, 520px);
    padding-bottom: 64px;
  }

  .timeline-heading h2 {
    font-size: 24px;
  }

  .timeline-list {
    padding-left: 28px;
  }

  .timeline-list::before {
    left: 4px;
  }

  .timeline-item::before {
    left: -28px;
  }

  .timeline-date {
    position: static;
    width: auto;
    margin-bottom: 7px;
    text-align: left;
  }
}
</style>
