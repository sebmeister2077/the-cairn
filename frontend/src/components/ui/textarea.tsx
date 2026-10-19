export function TextArea(props: React.ComponentProps<"textarea">) {
  const { className, ...rest } = props;
  return (
    <textarea
      className={
        "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30 " +
        (className ?? "")
      }
      {...rest}
    />
  );
}
