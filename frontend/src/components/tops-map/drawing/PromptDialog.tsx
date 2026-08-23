// Themed text-input dialog used across the planning-board UI in place of the
// native `window.prompt`.

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface PromptDialogProps {
  open: boolean;
  title: string;
  label?: string;
  initialValue?: string;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function PromptDialog({
  open,
  title,
  label,
  initialValue = "",
  placeholder,
  submitLabel = "Save",
  onSubmit,
  onCancel,
}: PromptDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {/* Keyed so each open starts from a fresh initial value without a
                    state-syncing effect. */}
        {open && (
          <PromptForm
            key={initialValue}
            label={label}
            initialValue={initialValue}
            placeholder={placeholder}
            submitLabel={submitLabel}
            onSubmit={onSubmit}
            onCancel={onCancel}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PromptForm({
  label,
  initialValue = "",
  placeholder,
  submitLabel = "Save",
  onSubmit,
  onCancel,
}: Omit<PromptDialogProps, "open" | "title">) {
  const [value, setValue] = useState(initialValue);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = value.trim();
        if (trimmed) onSubmit(trimmed);
      }}
      className="space-y-2"
    >
      {label && <Label className="text-xs">{label}</Label>}
      <Input
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
      />
      <DialogFooter className="gap-2 pt-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!value.trim()}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
