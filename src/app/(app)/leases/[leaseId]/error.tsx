"use client";

import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function LeaseError({ reset }: { error: Error; reset: () => void }) {
  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle>Could not load this lease</CardTitle>
        <CardDescription>Something went wrong on our side. Try again in a moment.</CardDescription>
      </CardHeader>
      <div className="px-4">
        <Button type="button" onClick={reset}>
          Try again
        </Button>
      </div>
    </Card>
  );
}
