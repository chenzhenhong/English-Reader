/**
 * Article cleaner: the page chrome must not reach the stored body.
 *
 * The cleaner is publisher-agnostic on purpose, so these fixtures are the
 * shapes real pages have: an unclosed `<p>` (a browser closes it), a byline
 * block, a copyright notice, a share row, and a repeated standfirst.
 */
import { readFileSync } from 'node:fs';
import { cleanArticle, normalizeParagraphs, proseScore, dedupeBlocks } from '../lib/clean.js';
import { extractTitle } from '../lib/text.js';

let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (ok) passed += 1;
  else failed += 1;
};

console.log('paragraph normalization');
{
  const html = '<p>One<p>Two<p>Three';
  const normalized = normalizeParagraphs(html);
  check('every paragraph is closed', (normalized.match(/<\/p>/g) ?? []).length === 3, normalized);
  check('the text is preserved', normalized.includes('One') && normalized.includes('Three'), normalized);
}

console.log('\nprose scoring');
{
  check('a real paragraph scores', proseScore('The blue wave did not stop at the border of the Lone Star State.') > 0);
  check('a byline scores zero', proseScore('By') === 0);
  check('a share button scores zero', proseScore('Listen') === 0);
  check('a copyright notice scores zero', proseScore('Copyright © 2026 NPR. All rights reserved. Visit our website terms of use.') === 0);
  check('a short speaker turn is prose', proseScore('GRISCOM: Thank you so much.') > 0);
  check('a stage direction is not prose', proseScore('(SOUN*BITE OF ARCHIVED RECORDING)') === 0);
  check('a short label scores zero', proseScore('Skip to main content') === 0);
}

console.log('\ndeduplication');
{
  const blocks = [
    { text: 'Ever since the ancient Greeks, we have suspected that soaking in hot water is good for you.' },
    { text: 'Ever since the ancient Greeks, we have suspected that soaking in hot water is good for you.' },
    { text: 'A completely different paragraph that follows the first one in the story.' },
  ];
  const out = dedupeBlocks(blocks);
  check('an exact repeat is dropped once', out.length === 2, String(out.length));
}

console.log('\npage cleaning');
{
  // The shape of a transcript page: unclosed paragraphs, a byline block, a
  // share row, the transcript itself, and a legal notice.
  const html = `
    <html><head><title>Sample story : NPR</title><style>.x{color:red}</style></head>
    <body>
      <a href="#main">Accessibility links</a>
      <a href="#main">Skip to main content</a>
      <p>By</p><p>Michelle Aslam</p><p>,</p><p>Rob Schmitz</p>
      <div class="actions"><p>Listen</p><p>Download</p><p>Embed</p><p>Transcript</p></div>
      <div class="transcript">
        <p><p>ROB SCHMITZ, HOST: <p><p>As the votes came in on election night Tuesday, some of the most shocking results were in Texas.
        <p>Democrats swept the top races in Texas with James Talarico winning a Senate seat and Gina Hinojosa winning the race for governor.
        <p>DAVID GRISCOM: Thank you so much for having me. It has been a really wonderful past few days.
        <p>SCHMITZ: What great timing, with a book title like that. Texas has a reputation for being a reliably red state.
      </div>
      <footer><p>Copyright © 2026 NPR. All rights reserved. Visit our website terms of use and permissions pages.</p>
      <p>NPR does not offer or accept money for coverage or interviews.</p>
      <p>Sponsor Message</p><p>Become an NPR sponsor</p></footer>
    </body></html>`;
  const result = cleanArticle(html, { title: 'Sample story : NPR' });
  const text = result.text;
  check('the byline is gone', !/Michelle Aslam/.test(text), text.slice(0, 200));
  check('the share row is gone', !/^Listen$/m.test(text) && !/^Embed$/m.test(text));
  check('the legal notice is gone', !/Copyright/.test(text) && !/NPR does not offer/.test(text));
  check('the sponsor block is gone', !/Sponsor Message/.test(text) && !/Become an NPR sponsor/.test(text));
  check('the skip links are gone', !/Accessibility links/.test(text) && !/Skip to main content/.test(text));
  check('the transcript is kept', /As the votes came in on election night/.test(text), text.slice(0, 200));
  check('the speaker turns are kept', /ROB SCHMITZ, HOST:/.test(text) && /DAVID GRISCOM:/.test(text));
  check('the closing line is kept', /SCHMITZ: What great timing/.test(text));
  check('the style block never leaks', !/color:red/.test(text));
  check('the cleaner reports what it dropped', result.dropped > 0, String(result.dropped));
  check('the paragraphs are separated by a blank line', text.includes('\n\n'));
}

console.log('\na repeated standfirst is kept once');
{
  const standfirst = 'Ever since the ancient Greeks, we have suspected that soaking in hot water is good for your health.';
  const html = `<body>
    <div class="standfirst"><p>${standfirst}</p></div>
    <div class="body"><p>${standfirst}</p>
    <p>A new study shows that a daily bath lowers blood pressure in adults who take one regularly.</p></div>
  </body>`;
  const result = cleanArticle(html);
  const occurrences = result.text.split(standfirst).length - 1;
  check('the standfirst appears once', occurrences === 1, String(occurrences));
  check('the body paragraph is kept', /lowers blood pressure/.test(result.text));
}

console.log('\nheadline extraction');
{
  // A page's <title> is a display label; the article's own headline is what
  // the reader should see.
  const npr = '<head><title>Some headline about things : NPR</title>'
    + '<meta property="og:site_name" content="NPR"><meta property="og:title" content="Some headline about things"></head>';
  check('the social-card title wins', extractTitle(npr) === 'Some headline about things', extractTitle(npr));

  const guardian = '<head><title>A story headline here | Health | The Guardian</title></head>';
  check('a section and site suffix are stripped', extractTitle(guardian) === 'A story headline here', extractTitle(guardian));

  const heading = '<head><title>t : NPR</title></head><body><h1>Headline from the page</h1></body>';
  check('the visible h1 is used before the title', extractTitle(heading) === 'Headline from the page', extractTitle(heading));

  const plain = '<head><title>A Plain Headline Without Any Suffix</title></head>';
  check('a plain title is untouched', extractTitle(plain) === 'A Plain Headline Without Any Suffix', extractTitle(plain));

  const colons = '<head><title>Analysis: what the vote means for the next two years</title></head>';
  check('a colon inside the headline is kept', extractTitle(colons) === 'Analysis: what the vote means for the next two years', extractTitle(colons));

  check('an empty document has no title', extractTitle('') === '');
}

console.log('\na photo caption is page furniture');
{
  // NPR prints the picture description, the credit and the "hide caption" toggle
  // as one paragraph. It reads like prose, so it needs the credit signal.
  const html = `
    <html><head><title>Some headline : NPR</title></head>
    <body>
      <p>After years of increasing to record-high levels, the homeless population in the U.S. dropped more than 6% in 2025.</p>
      <div class="credit-caption"><div class="caption-wrap"><div class="caption">
        <p>People line up along temporary tents to partake in a free Thanksgiving meal provided by the Union Rescue Mission as the Los Angeles Skid Row district annual feast hosts thousands of homeless and others in need, in downtown Los Angeles on Nov. 24, 2022.
          <b class="credit">Damian Dovarganes/AP</b>
          <b class="hide-caption"><b>hide caption</b></b>
        </p>
      </div></div></div>
      <p>That amounts to roughly 49,000 fewer people without housing, and it is the second year in a row that homelessness has declined.</p>
    </body></html>`;
  const result = cleanArticle(html, { title: 'Some headline : NPR' });
  check('the caption paragraph is dropped', !/hide caption/i.test(result.text), result.text.slice(0, 200));
  check('the caption credit is dropped', !/Dovarganes/.test(result.text));
  check('the body paragraphs are kept', /After years of increasing/.test(result.text) && /49,000 fewer/.test(result.text), result.text.slice(0, 200));
  check('the caption counts as dropped furniture', result.dropped >= 1, String(result.dropped));
}

console.log('\na real DOM decides what is prose and what is chrome');
{
  const prose = 'The article body is real prose and it must survive the cleaning pass.';
  const prose2 = 'The closing line is a different sentence and it is also body copy.';
  const chrome = 'This is page furniture and it is not article prose at all.';

  // Only text inside a prose element is collected. A bare <div> is page layout,
  // not prose, so text directly in one is not the article.
  const proseOnly = cleanArticle(`<div>${chrome}</div><p>${prose}</p>`, {});
  check('text outside a prose element is not collected', !/page furniture/.test(proseOnly.text), proseOnly.text);
  check('text inside a paragraph is collected', prose.includes(proseOnly.paragraphs[0] ?? ''), proseOnly.text);

  // Chrome containers drop their text before it is ever scored.
  const structural = cleanArticle(`
    <figure><figcaption><p>${chrome}</p></figcaption></figure>
    <aside><p>${chrome}</p></aside>
    <nav><p>${chrome}</p></nav>
    <form><p>${chrome}</p></form>
    <p>${prose}</p>`, {});
  check('a figure caption is dropped structurally', !/page furniture/.test(structural.text), structural.text.slice(0, 160));
  check('an aside is dropped structurally', !/page furniture/.test(structural.text));
  check('a nav is dropped structurally', !/page furniture/.test(structural.text));
  check('a form is dropped structurally', !/page furniture/.test(structural.text));
  check('real body prose survives the chrome drop', prose.includes(structural.paragraphs[0] ?? ''), structural.text);

  // Chrome text must not merge with the prose around it.
  const mixed = cleanArticle(`<li>${prose} <button>${chrome}</button> ${prose2}</li>`, {});
  check('chrome text does not merge with prose', !/page furniture/.test(mixed.text), mixed.text);
  check('the prose around the chrome survives', /real prose/.test(mixed.text) && /closing line/.test(mixed.text), mixed.text);

  // A block that still carries markup is chrome, not prose.
  check('a block with residual markup scores zero',
    proseScore('Embed <iframe src="https://x.test/embed" width="100%"></iframe>') === 0);
  check('clean prose still scores', proseScore(prose) > 0);

  // A browser closes an open <p> when a block start tag arrives, so NPR's
  // transcript lines stay separate instead of nesting into one paragraph.
  const nested = cleanArticle(`<div><p>${prose}<p>${prose2}</p></div>`, {});
  check('nested paragraphs stay separate', nested.paragraphs.length === 2, JSON.stringify(nested.paragraphs));
}

console.log('\nan empty or broken page yields nothing');
{
  check('empty html yields nothing', cleanArticle('').text === '');
  check('a page without paragraphs yields nothing', cleanArticle('<html><body><h1>Only a headline</h1></body></html>').text === '');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
