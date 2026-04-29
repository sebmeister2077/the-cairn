import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

export function RekeyResultDialog({
  result,
  onClose,
}: {
  result: { user: string; key: string } | null;
  onClose: () => void;
}) {
  if (!result) return null;
  return (
    <Dialog open={!!result} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New API key generated</DialogTitle>
          <DialogDescription>
            Deliver this key to the user securely. It will not be shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input readOnly value={result.key} className="font-mono text-xs" />
          <Button onClick={() => navigator.clipboard.writeText(result.key)}>Copy</Button>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
