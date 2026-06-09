import Link from 'next/link';
import { Panel, Kicker } from '@/components/ui';

/** A10 — friendly 404 inside the shell for unknown routes. */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl py-20">
      <Panel className="p-6">
        <Kicker>404 · no such route</Kicker>
        <h1 className="font-display mt-2 text-lg text-ink">Off the map</h1>
        <p className="text-dim mt-2 font-mono text-[12px]">
          That route doesn’t exist.{' '}
          <Link href="/" className="text-amber hover:underline">
            Return to the fleet
          </Link>
          .
        </p>
      </Panel>
    </div>
  );
}
