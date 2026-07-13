import Link from "next/link";
import { Button } from "@/components/ui";

/** 404 boundary — unknown routes and `notFound()` calls land here. */
export default function NotFound() {
  return (
    <div className="flex min-h-[70dvh] flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-4xl font-bold tabular-nums text-primary-600">404</p>
      <h1 className="text-lg font-semibold text-ink-900">Page not found</h1>
      <p className="max-w-xs text-sm text-ink-600">
        The page you&rsquo;re looking for doesn&rsquo;t exist or may have moved.
      </p>
      <Link href="/" className="mt-2 w-full max-w-xs">
        <Button className="w-full">Go to home</Button>
      </Link>
    </div>
  );
}
