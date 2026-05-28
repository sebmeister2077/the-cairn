import { NavLink } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const LAST_UPDATED = "15 мая 2026";
const CONTACT_EMAIL = "vswaypoint.jokingly672@passinbox.com";

export function TermsPageRu() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Условия использования</CardTitle>
        <p className="text-xs text-muted-foreground">Последнее обновление: {LAST_UPDATED}</p>
      </CardHeader>
      <CardContent className="space-y-6 text-sm leading-relaxed text-muted-foreground">
        <section className="rounded border border-amber-300 bg-amber-50 p-3 text-amber-900">
          <strong>Черновое уведомление.</strong> Эти условия описывают, как оператор ожидает, что
          будет использоваться сервис. Это не юридическая консультация. Вопросы:{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
            {CONTACT_EMAIL}
          </a>
          .
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">1. Принятие условий</h2>
          <p>
            Получая доступ к Cairn («Сервис») или используя его, вы соглашаетесь соблюдать эти
            Условия использования и нашу{" "}
            <NavLink to="/privacy" className="underline">
              Политику конфиденциальности
            </NavLink>
            . Если вы не согласны, не используйте сервис.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">2. Право на использование</h2>
          <p>Для использования сервиса вам должно быть не менее 13 лет (16 лет в ЕС).</p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">3. API keys и аккаунты</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              Доступ предоставляется только по приглашению. API keys выдаются по усмотрению
              оператора.
            </li>
            <li>Вы обязаны хранить свой API key в секрете. Относитесь к нему как к паролю.</li>
            <li>
              При первом использовании ваш API key автоматически связывается с one-way hash
              IP-адреса, с которого он был использован. Эта привязка нужна оператору для обнаружения
              alt accounts и применения IP-level bans. Подробности смотрите в{" "}
              <NavLink to="/privacy" className="underline">
                Политике конфиденциальности
              </NavLink>
              .
            </li>
            <li>
              <strong>Профиль аккаунта</strong> создается при первом использовании сервиса. Он
              включает автоматически сгенерированное публичное display name и необязательные поля,
              которыми вы управляете сами (in-game name, hireable status, leaderboard visibility).
              Вы можете ограниченное число раз регенерировать display name, менять in-game name,
              экспортировать данные или удалять аккаунт в любой момент через страницу{" "}
              <strong>Account</strong>. Удаление аккаунта — это soft-delete: профиль anonymised, API
              key revoked, но внесенные вами вклады в community map остаются в общем датасете под
              anonymised display name.
            </li>
            <li>
              Оператор может в любой момент, с уведомлением или без него, отозвать любой key,
              регенерировать любое display name или выполнить soft-delete любого аккаунта при
              злоупотреблениях, подозрении на неавторизованное использование или по иной причине.
            </li>
            <li>
              Вы не должны публиковать свой key, использовать его от имени пользователей, которым
              вам не было разрешено делегировать доступ, создавать alt accounts для обхода rate
              limits или bans, либо выдавать себя за другого пользователя через display name или
              in-game name.
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">4. Допустимое использование</h2>
          <p>Вы соглашаетесь не:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              Загружать malware, незаконный контент или файлы, на публикацию которых у вас нет прав.
            </li>
            <li>
              Загружать save files или map data, принадлежащие другим игрокам, без их разрешения.
            </li>
            <li>
              Пытаться обходить rate limits, массово scrape-ить сервис или проводить
              denial-of-service атаки.
            </li>
            <li>
              Reverse-engineer, probe или атаковать инфраструктуру либо данные других пользователей.
            </li>
            <li>
              Использовать сервис для нарушения EULA Vintage Story или прав интеллектуальной
              собственности третьих лиц.
            </li>
            <li>
              Использовать сервис как канал для передачи сообщений, коммуникаций, рекламы или иной
              информации любым другим пользователям или широкой публике, включая размещение такого
              контента в display name аккаунта, in-game name, названиях путевых точек или любых иных
              free-text полях. Сервис предназначен для данных карты и путевых точек, а не для обмена
              сообщениями. Оператор вправе по своему усмотрению изменить или удалить такое поле,
              отозвать ваш API key и забанить аккаунт без уведомления.
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">5. Rate limits</h2>
          <p>
            Сервис применяет rate limits (сейчас по умолчанию 5 запросов в час на key) для защиты от
            злоупотреблений. Лимиты могут изменяться в любой момент без уведомления.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">6. Вклады в карту сообщества</h2>
          <p>
            Когда вы отправляете файл кэша карты через инструмент <strong>Contribute</strong>:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              Вы подтверждаете, что имеете право загружать эти данные и что это не нарушает ничьих
              прав.
            </li>
            <li>
              Вы предоставляете оператору{" "}
              <strong>
                бессрочную, безотзывную, всемирную, безвозмездную, передаваемую по сублицензии
                лицензию
              </strong>{" "}
              на хостинг, показ, изменение, объединение и перераспределение переданных данных как
              части общей карты сообщества. Такое перераспределение может принимать любую форму,
              которую выберет оператор, включая отрисованные изображения карты, machine-readable map
              chunks, statistical summaries и, если такая функция будет предложена, raw или merged
              map-cache database files.
            </li>
            <li>
              Одобренные вклады <strong>необратимо объединяются</strong> с community map и не могут
              быть отозваны. Пожалуйста, будьте уверены перед отправкой.
            </li>
            <li>
              Оператор может отклонить, удалить или откатить pending contributions в любой момент
              без уведомления.
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">
            7. Интеллектуальная собственность
          </h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              Сервис, включая исходный код, дизайн и контент, является proprietary property
              оператора.
              <strong> Все права защищены.</strong> Никакая лицензия, явная или подразумеваемая, не
              предоставляет вам право копировать, изменять, распространять, сублицензировать,
              reverse engineer-ить или создавать производные работы от сервиса или его исходного
              кода, кроме случаев, прямо разрешенных оператором в письменной форме или применимым
              правом.
            </li>
            <li>
              Ваше право использовать сервис является ограниченным, персональным, непередаваемым,
              неисключительным и отзывным разрешением на доступ к размещенному сервису в
              соответствии с этими Terms. Это не передает вам никакого владения сервисом.
            </li>
            <li>
              «Vintage Story» является товарным знаком Anego Studios. Сервис — неофициальный
              фанатский проект и не связан с Anego Studios.
            </li>
            <li>
              <strong>
                При создании этого сервиса не использовался декомпилированный игровой код.
              </strong>
              Вся работа с форматами файлов (waypoint <code>.vcdbs</code> и multiplayer map cache
              <code>.db</code>) была разработана путем анализа байтовой структуры файлов, которые
              создаются на диске пользовательским игровым клиентом, а также с опорой на
              общедоступную документацию сообщества. Сервис не содержит игровых ассетов и не
              включает код, скопированный или переведенный из декомпилированных бинарников{" "}
              <em>Vintage Story</em>.
            </li>
            <li>
              Лицензия на dataset community map еще должна быть подтверждена; до явного указания
              рассматривайте его как «all rights reserved by the operator and contributors
              collectively».
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">8. Отказ от гарантий</h2>
          <p>
            Сервис предоставляется <strong>«КАК ЕСТЬ» и «ПО МЕРЕ ДОСТУПНОСТИ»</strong>, без
            каких-либо гарантий, явных или подразумеваемых. Оператор не гарантирует, что сервис
            будет работать непрерывно, без ошибок, либо что загрузки, merges и generated files будут
            точными или сохраненными.
          </p>
          <p>
            <strong>
              Всегда храните резервные копии save files перед использованием Import, Delete или
              любых инструментов, которые изменяют их.
            </strong>
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">
            9. Ограничение ответственности
          </h2>
          <p>
            В максимально допустимой законом степени оператор не несет ответственности за любые
            прямые, косвенные, случайные, специальные, последующие или штрафные убытки, возникшие из
            вашего использования сервиса, включая повреждение save files, потерю waypoints, map data
            или простои сервиса.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">10. Возмещение убытков</h2>
          <p>
            Вы соглашаетесь возмещать и освобождать оператора от претензий, убытков или расходов,
            возникающих из-за контента, который вы загружаете, или вашего нарушения этих Terms.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">11. Прекращение доступа</h2>
          <p>
            Оператор может приостановить или прекратить ваш доступ к сервису в любое время, с
            уведомлением или без него, по любой причине, включая нарушение этих Terms.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">12. Применимое право</h2>
          <p>
            Эти Terms регулируются законодательством Румынии без учета ее коллизионных норм. Любой
            спор, возникающий из этих Terms или в связи с вашим использованием сервиса, подлежит
            исключительной юрисдикции компетентных судов Румынии.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">13. Изменения условий</h2>
          <p>
            Мы можем обновлять эти Terms. Существенные изменения будут увеличивать и версию consent
            banner, и server-side terms version, записанную в вашем аккаунте, что потребует
            повторного принятия при следующем посещении. Дата «Последнее обновление» в верхней части
            страницы отражает самую свежую редакцию. Продолжение использования после изменений
            означает принятие новых Terms.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">14. Контакты</h2>
          <p>
            Вопросы:{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </section>
      </CardContent>
    </Card>
  );
}
