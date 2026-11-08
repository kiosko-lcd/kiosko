/**
 * Icons are Lucide (ISC licence). Plugins name them in kebab-case
 * (`hourglass`, `git-pull-request`); any Lucide name works.
 */
import { icons } from 'lucide';

type Node = [string, Record<string, string>][];
const pascal = (s: string) => s.replace(/(^|[-_ ])(\w)/g, (_m, _a, c: string) => c.toUpperCase());

export function Icon({ name, size = 18, class: cls, stroke = 1.75 }: { name?: string; size?: number; class?: string; stroke?: number }) {
  if (name?.trim().startsWith('<svg')) return <span class={`icon ${cls ?? ''}`} style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: name }} />;
  const node = (icons as Record<string, Node>)[pascal(name ?? 'square')] ?? (icons as Record<string, Node>).Square!;
  return (
    <svg class={`icon ${cls ?? ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {node.map(([tag, attrs], i) => {
        const T = tag as 'path';
        return <T key={i} {...(attrs as Record<string, string>)} />;
      })}
    </svg>
  );
}
