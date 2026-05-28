import { useState, type ChangeEvent } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "@/lib/i18n";

interface FileUploadProps {
  id: string;
  label: string;
  accept?: string;
  required?: boolean;
  disabled?: boolean;
  onChange: (file: File | null) => void;
}

/** Format a byte count as a short human-readable string. */
function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(2)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function FileUpload({ id, label, accept, required, disabled, onChange }: FileUploadProps) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<File | null>(null);

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setPicked(file);
    onChange(file);
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </Label>
      <Input
        id={id}
        type="file"
        accept={accept}
        required={required}
        disabled={disabled}
        onChange={handleChange}
      />
      {picked && (
        <p className="text-xs text-muted-foreground">
          {t("common.size")}:{" "}
          <span className="font-medium text-foreground">{formatFileSize(picked.size)}</span>
        </p>
      )}
    </div>
  );
}
