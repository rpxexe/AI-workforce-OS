import { FileQuestion } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <div className="w-full max-w-md">
        <EmptyState icon={FileQuestion} title="Page not found" description="The page you are looking for does not exist or was moved.">
          <Button asChild>
            <Link href="/">Back to the dashboard</Link>
          </Button>
        </EmptyState>
      </div>
    </main>
  );
}
