import { useState, type ChangeEvent } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "@/lib/i18n";
import { formatBytes } from "@/lib/formatting/format-bytes";

interface FileUploadProps {
  id: string;
  label: string;
  accept?: string;
  required?: boolean;
  disabled?: boolean;
  onChange: (file: File | null) => void;
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
          <span className="font-medium text-foreground">{formatBytes(picked.size)}</span>
        </p>
      )}
    </div>
  );
}
