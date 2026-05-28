import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  CheckCircle2,
  FileText,
  HelpCircle,
  Link2,
  MapPinned,
  MousePointer2,
  Send,
  Upload,
} from "lucide-react";
import parseExampleImg from "@/assets/ContributeTLsParseExample.png";
import previewExampleImg from "@/assets/ContributeTLsPreviewExample.png";

export function AddingTranslocatorsWithContributeTLsPostRu() {
  return (
    <div className="space-y-6 text-sm leading-relaxed">
      <Lede>
        Этот гайд описывает поток <strong>Contribute TLs</strong>, который использует ваши
        собственные путевые точки Vintage Story. Вы запускаете <Code>/waypoint list details</Code>,
        загружаете <Code>client-chat.log</Code>, а Cairn превращает spiral-записи в готовые для
        карты пары транслокаторов.
      </Lede>

      <Section title="Перед загрузкой" icon={<FileText className="size-4" />}>
        <P>
          Войдите в аккаунт Cairn или создайте его. Отправку все равно можно оставить анонимной, но
          привязка к аккаунту нужна, чтобы владелец мог позже отозвать свой вклад, а админы -
          ограничивать злоупотребления.
        </P>
        <P>
          Эта страница читает не скриншоты и не файлы карты, а список путевых точек из вашего
          чат-лога. Введите в игре команду ниже:
        </P>
        <Pre>{`/waypoint list details`}</Pre>
        <P>
          Команда печатает полный список путевых точек в чат и одновременно записывает его в
          <Code>client-chat.log</Code>. Этот лог и нужно загружать в поток Contribute TLs.
        </P>
        <Callout>
          Считываются только путевые точки с иконкой <Code>spiral</Code>. Базы, заметки, ориентиры и
          другие пользовательские метки игнорируются и не отправляются.
        </Callout>
      </Section>

      <Section title="Шаг 1: загрузите client-chat.log" icon={<Upload className="size-4" />}>
        <P>
          Перейдите на страницу{" "}
          <NavLink
            to="/multiplayer/contribute-tls"
            className="underline decoration-dotted underline-offset-2 hover:text-primary"
          >
            Contribute TLs
          </NavLink>
          . На Windows нужный файл обычно лежит здесь:
        </P>
        <Pre>{String.raw`%appdata%\VintagestoryData\Logs\client-chat.log`}</Pre>
        <P>
          Выберите файл, нажмите <strong>Parse file</strong> и дождитесь сводки. Если сервис пишет,
          что spiral-точек не найдено, снова выполните <Code>/waypoint list details</Code> в игре и
          загрузите обновленный лог.
        </P>
        <ImageFigure
          src={parseExampleImg}
          alt="Contribute TLs после разбора чат-лога."
          caption="После разбора карточка показывает общее число точек, сколько из них похоже на TL и сколько уже известно, новые или без пары."
        />
      </Section>

      <Section title="Шаг 2: проверьте сводку" icon={<CheckCircle2 className="size-4" />}>
        <Ul>
          <li>
            <strong>Already on the map</strong> - обе стороны совпали с уже известным TL и будут
            пропущены при отправке.
          </li>
          <li>
            <strong>New pairs</strong> - пары, которые Cairn считает пригодными для отправки, хотя
            часть из них может потребовать ручной проверки.
          </li>
          <li>
            <strong>Unpaired</strong> - записи, где найден только один пригодный конец.
          </li>
        </Ul>
        <P>
          Если сводка выглядит правдоподобно, нажмите <strong>Continue to review</strong>.
        </P>
      </Section>

      <Section title="Шаг 3: просмотрите пары на карте" icon={<MapPinned className="size-4" />}>
        <P>
          На экране проверки слева показана карта TOPS, а справа - пары, собранные из ваших путевых
          точек. Клик по строке приближает карту к TL, а клик по endpoint-у на карте выбирает
          соответствующую запись в списке.
        </P>
        <ImageFigure
          src={previewExampleImg}
          alt="Экран проверки Contribute TLs с картой и списком пар."
          caption="На странице проверки вы подтверждаете понятные пары, исправляете неоднозначные и удаляете лишние записи."
        />
      </Section>

      <Section title="Что означают статусы" icon={<HelpCircle className="size-4" />}>
        <StatusGrid>
          <StatusCard label="Новая - подтверждена" variant="default">
            Партнер найден однозначно, запись готова к отправке.
          </StatusCard>
          <StatusCard label="Новая - нужна проверка" variant="secondary">
            Рядом было несколько возможных партнеров, поэтому пару нужно подтвердить вручную.
          </StatusCard>
          <StatusCard label="Без пары" variant="destructive">
            У записи отсутствует вторая сторона. Ее нужно связать, отредактировать или удалить.
          </StatusCard>
          <StatusCard label="Некорректно" variant="destructive">
            Координаты или структура записи ошибочны, исправьте ее или уберите.
          </StatusCard>
          <StatusCard label="Уже на карте" variant="outline">
            Оба конца совпали с известным TL; строка оставлена только для справки.
          </StatusCard>
        </StatusGrid>
      </Section>

      <Section title="Исправьте пары перед отправкой" icon={<Link2 className="size-4" />}>
        <P>
          Если пара сомнительная, используйте инструменты проверки: подтверждение предложенной пары,
          ручное редактирование координат, показ pairing candidates, режим{" "}
          <strong>Link two TLs</strong> и перетаскивание ручек endpoint-ов на карте.
        </P>
        <Callout>
          Автосвязывание работает лучше всего, когда в названии каждой spiral-точки есть примерные
          координаты противоположной стороны.
        </Callout>
      </Section>

      <Section title="Шаг 4: отправка" icon={<Send className="size-4" />}>
        <P>
          Когда пакет готов, нажмите <strong>Submit contribution</strong>. В окне подтверждения вы
          увидите, сколько пар будет отправлено, а сколько строк будет пропущено как без пары,
          некорректные или уже существующие на карте.
        </P>
        <P>
          Подходящие TL появляются на карте сразу после того, как backend примет вклад, и слой TL на
          странице обновится без перезагрузки.
        </P>
      </Section>

      <Separator />

      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm">
            <p className="font-medium text-foreground">Готовы добавить TL?</p>
            <p className="text-muted-foreground">
              Выполните <Code>/waypoint list details</Code>, возьмите <Code>client-chat.log</Code> и
              откройте Contribute TLs.
            </p>
          </div>
          <NavLink to="/multiplayer/contribute-tls">
            <Button>
              <MousePointer2 className="mr-1.5 size-4" />
              Открыть Contribute TLs
            </Button>
          </NavLink>
        </CardContent>
      </Card>
    </div>
  );
}

function Lede({ children }: { children: ReactNode }) {
  return (
    <p className="border-l-2 border-primary/40 pl-3 text-base leading-relaxed text-foreground/90">
      {children}
    </p>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
        {icon ? <span className="text-primary">{icon}</span> : null}
        {title}
      </h2>
      <div className="space-y-3 text-muted-foreground">{children}</div>
    </section>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p>{children}</p>;
}
function Ul({ children }: { children: ReactNode }) {
  return <ul className="list-disc list-outside space-y-1.5 pl-5">{children}</ul>;
}
function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
      {children}
    </code>
  );
}
function Pre({ children }: { children: ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded border bg-muted/40 p-3 font-mono text-xs text-foreground">
      {children}
    </pre>
  );
}
function Callout({ children }: { children: ReactNode }) {
  return (
    <div className="rounded border border-sky-300 bg-sky-50 p-3 text-xs text-sky-900">
      {children}
    </div>
  );
}
function ImageFigure({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <figure className="space-y-2">
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className="block overflow-hidden rounded border bg-muted/40"
      >
        <img src={src} alt={alt} loading="lazy" className="h-auto w-full" />
      </a>
      <figcaption className="text-center text-xs text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}
function StatusGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2">{children}</div>;
}
function StatusCard({
  label,
  variant,
  children,
}: {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
  children: ReactNode;
}) {
  return (
    <div className="space-y-2 rounded border bg-card p-3">
      <Badge variant={variant}>{label}</Badge>
      <p className="text-xs text-muted-foreground">{children}</p>
    </div>
  );
}
