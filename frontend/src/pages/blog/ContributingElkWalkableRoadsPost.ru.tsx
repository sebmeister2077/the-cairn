import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { AlertTriangle, Clock, Footprints, Settings2, Sparkles, Upload } from "lucide-react";
import preferToggleImg from "@/assets/Guides/Elk-roads/PreferElkWalkableRoutes.png";
import estimateImg from "@/assets/Guides/Elk-roads/EstimateTimeWithElkWalkableRouteSetting.png";
import tooltipImg from "@/assets/Guides/Elk-roads/RouteEstimateTimeWithTooltip.png";
import submitImg from "@/assets/Guides/Elk-roads/SubmitContributionsElkRoad.png";

export function ContributingElkWalkableRoadsPostRu() {
  return (
    <div className="space-y-6 text-sm leading-relaxed">
      <Lede>
        Лось быстр на дорогах, но не пересечёт пропасть, береговую линию или кислоту. Планировщик
        маршрутов знает, где соединяются транслокаторы, но только сообщество знает, какие пешие
        срезки лось реально проходит. Этот гайд показывает, как включить предпочтение «лосиных»
        путей, как читать оценку времени и как подтверждать пеший участок как пригодный для лося,
        чтобы другим игрокам было удобнее.
      </Lede>

      <Section title="Включите предпочтение лося" icon={<Settings2 className="size-4" />}>
        <P>
          В планировщике маршрута найдите слайдер <strong>Штраф TL</strong> и включите{" "}
          <strong>Предпочитать «лосиные» маршруты</strong>. Планировщик начнёт сильно отдавать
          предпочтение пешим срезкам, которые уже подтвердило сообщество.
        </P>

        <ImageFigure
          src={preferToggleImg}
          alt="Слайдер штрафа TL на 19с и включённый переключатель Предпочитать «лосиные» маршруты с поясняющим текстом."
          caption="Включите переключатель. Неподтверждённые срезки остаются в выдаче, но с большим штрафом по времени, чтобы подтверждённые цепочки выигрывали, когда это разумно."
        />

        <Callout tone="info">
          <strong>Штраф TL</strong> сверху — отдельная настройка: фиксированная цена времени за
          каждый прыжок (зарядка, подъём по лестнице). Обе настройки влияют на ранжирование
          альтернатив.
        </Callout>
      </Section>

      <Section title="Как читать оценку времени" icon={<Clock className="size-4" />}>
        <P>
          С включённым предпочтением каждая альтернатива показывает{" "}
          <strong>интервал времени</strong>, а не одно число. Нижняя граница считает все пешие
          участки лосиными, верхняя — что любой непроверенный участок потребует дополнительных
          усилий.
        </P>

        <ImageFigure
          src={estimateImg}
          alt="Альтернатива №2: 1345 блоков, 2 TL, оценка 3м 50с – 5м 50с, у одного пешего участка значок «+ до 2м 0с, если не подтверждено»."
          caption="Каждый непроверенный пеший участок помечается значком «+ до X». Это та добавка по времени, которая придёт, если лось всё-таки не сможет там пройти."
        />

        <Checklist>
          <li>
            <strong>Лучший (нижняя граница):</strong> все пешие участки считаются лосиными.
          </li>
          <li>
            <strong>Худший (верхняя граница):</strong> каждый непроверенный участок стоит полного
            штрафа.
          </li>
          <li>
            <strong>Подтверждённые участки</strong> идут без значка — сообщество их уже заверило.
          </li>
        </Checklist>
      </Section>

      <Section title="Отметьте пеший участок как лосиный" icon={<Footprints className="size-4" />}>
        <P>
          Рядом с каждым пешим участком есть кнопка с лапкой. При наведении показывается{" "}
          <strong>Mark this walk as elk-walkable</strong>. Клик добавляет заверение в локальный
          черновик: участок становится ожидающим вкладом и появляется в карточке{" "}
          <strong>Elk-walkable contributions</strong> ниже маршрута.
        </P>

        <ImageFigure
          src={tooltipImg}
          alt="Альтернатива №3, видна подсказка Mark this walk as elk-walkable у кнопки с лапкой, ниже карточка Elk-walkable contributions с легендой Confirmed, Unconfirmed, Marking elk-walkable, Removing my attestation."
          caption="Кнопка с лапкой ставит заверение в локальный черновик. Карточка снизу показывает легенду и состояние черновика."
        />

        <StatusGrid>
          <MiniCard
            heading="Confirmed"
            badge={<Badge className="bg-emerald-600 hover:bg-emerald-600">подтверждено</Badge>}
          >
            Хотя бы один игрок уже заверил этот участок. Планировщик считает его лосиным на полной
            скорости.
          </MiniCard>
          <MiniCard heading="Unconfirmed" badge={<Badge variant="outline">нет данных</Badge>}>
            Никто ещё не заверял этот участок. Планировщик его показывает, но применяет штраф за
            неподтверждённость.
          </MiniCard>
          <MiniCard
            heading="Marking elk-walkable"
            badge={<Badge variant="secondary">черновик</Badge>}
          >
            Вы добавили заверение в локальный черновик. Оно учтётся только после отправки.
          </MiniCard>
          <MiniCard
            heading="Removing my attestation"
            badge={<Badge variant="secondary">черновик</Badge>}
          >
            Вы хотите снять ранее поставленное заверение. Тоже ждёт отправки.
          </MiniCard>
        </StatusGrid>

        <Callout tone="info">
          Кнопка с лапкой видна только для участков, у которых оба конца имеют стабильный
          идентификатор. Если кнопки нет — один из концов виртуальный (старт/финиш) или ещё не
          получил id.
        </Callout>
      </Section>

      <Section title="Отправьте свои вклады" icon={<Upload className="size-4" />}>
        <P>
          Когда в черновике есть хотя бы один участок, кнопка <strong>Submit contributions</strong>{" "}
          внизу карточки становится активной. Каждая запись черновика показывает обе точки, чтобы вы
          могли перепроверить отправляемое.
        </P>

        <ImageFigure
          src={submitImg}
          alt="Два заверения пеших участков с координатами концов, ниже кнопки Submit contributions и Clear draft."
          caption="Типичный черновик: два участка готовы к отправке. Clear draft отменяет всё локально, Submit contributions отправляет на сервер."
        />

        <Checklist>
          <li>
            <strong>Submit contributions</strong> отправляет все заверения и снятия одним запросом.
            При успехе появляется строка «Submitted N changes. Thanks!».
          </li>
          <li>
            <strong>Clear draft</strong> сбрасывает черновик локально — ничего не отправляется.
          </li>
          <li>
            Для отправки нужен аккаунт Cairn. Анонимные пользователи могут пользоваться
            предпочтением, но не могут заверять.
          </li>
        </Checklist>
      </Section>

      <Section title="Этикет заверений" icon={<AlertTriangle className="size-4" />}>
        <Checklist>
          <li>
            <strong>Заверяйте только то, что реально проехали верхом на лосе.</strong> «На карте
            выглядит нормально» — недостаточно: пропасти, узкие береговые полосы и кислотные озёра
            прячутся между чанками.
          </li>
          <li>
            <strong>Снимайте заверение</strong>, если маршрут перестал работать (изменения
            ландшафта, обновление мира). Клик по лапке на подтверждённом участке поставит снятие в
            черновик.
          </li>
          <li>
            <strong>Короткие участки полезнее.</strong> Длинные пешие переходы переиспользуются во
            многих маршрутах, но именно короткие повышают гибкость планировщика.
          </li>
          <li>
            <strong>Не дублируйте одну и ту же цепочку.</strong> Достаточно одного заверения от
            аккаунта на участок — планировщик и так доверяет подтверждённым.
          </li>
        </Checklist>
      </Section>

      <Separator />

      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm">
            <p className="font-medium text-foreground">Готовы заверить срезку?</p>
            <p className="text-muted-foreground">
              Откройте карту TOPS, постройте маршрут и нажмите кнопку с лапкой рядом с пешим
              участком.
            </p>
          </div>
          <NavLink to="/multiplayer/tops-map">
            <Button>
              <Sparkles className="mr-1.5 size-4" />
              Открыть карту TOPS
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

function Checklist({ children }: { children: ReactNode }) {
  return <ul className="list-disc list-outside space-y-2 pl-5">{children}</ul>;
}

function Callout({ tone, children }: { tone: "info" | "warning"; children: ReactNode }) {
  const cls =
    tone === "warning"
      ? "border-amber-300 bg-amber-50 text-amber-900"
      : "border-sky-300 bg-sky-50 text-sky-900";
  return <div className={`rounded border ${cls} p-3 text-xs`}>{children}</div>;
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

function MiniCard({
  heading,
  badge,
  children,
}: {
  heading: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5 rounded border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{heading}</p>
        {badge}
      </div>
      <p className="text-xs text-muted-foreground">{children}</p>
    </div>
  );
}
