import "./school-welcome.css";

/**
 * Brief "school website" landing page shown once at app start (see App.tsx +
 * lib/welcome). Deliberately generic and product-neutral: it reads as an
 * ordinary independent-school homepage and never mentions the application
 * behind it.
 *
 * App controls the duration and transition; the Continue control in the
 * utility bar lets the impatient skip it, and every nav/CTA anchor scrolls
 * within the page.
 */
export default function Welcome({ onDone }: { onDone: () => void }) {
  return (
    <div className="school-site">
      <div className="school-utility">
        <p className="school-utility__notice">
          <span className="school-dot" aria-hidden="true" />
          Open Morning · Saturday 14 November · <a href="#visit">Reserve a place</a>
        </p>
        <div className="school-utility__links">
          <span>Parent Portal</span>
          <span>Staff</span>
          <button type="button" className="school-continue" onClick={onDone}>
            Continue <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>

      <header className="school-header">
        <a className="school-brand" href="#top" aria-label="Wrenfield Academy — home">
          <svg
            className="school-crest"
            viewBox="0 0 48 56"
            role="img"
            aria-label="Wrenfield Academy crest"
          >
            <path
              d="M24 2 4 9v20c0 12 8.6 20.6 20 25 11.4-4.4 20-13 20-25V9L24 2Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
            />
            <path
              d="M24 8.5 9.6 13.4v15.2c0 9 6.2 15.6 14.4 19.2 8.2-3.6 14.4-10.2 14.4-19.2V13.4L24 8.5Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              opacity=".55"
            />
            <path
              d="M14 22.5c3.4-1.7 6.6-1.7 10 0 3.4-1.7 6.6-1.7 10 0v11c-3.4-1.7-6.6-1.7-10 0-3.4-1.7-6.6-1.7-10 0v-11Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <path d="M24 22.5v11" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="24" cy="17" r="2.1" fill="currentColor" />
          </svg>
          <span className="school-brand__text">
            <span className="school-brand__name">Wrenfield Academy</span>
            <span className="school-brand__motto">Est. 1897 · Learning for life</span>
          </span>
        </a>

        <nav className="school-nav" aria-label="Main">
          <a href="#about">About</a>
          <a href="#academics">Academics</a>
          <a href="#news">News &amp; events</a>
          <a href="#visit">Admissions</a>
        </nav>
      </header>

      <main id="top">
        <section className="school-hero" aria-labelledby="school-hero-title">
          <div className="school-hero__copy">
            <p className="school-eyebrow">Admissions for 2027 are now open</p>
            <h1 id="school-hero-title" className="school-hero__title">
              A place to think.
              <br />
              A place to belong.
            </h1>
            <p className="school-lede">
              Wrenfield is an independent day and boarding school for pupils
              aged 11 to 18. We combine a rigorous academic curriculum with
              music, sport, and the quieter habits of a thoughtful community.
            </p>
            <div className="school-actions">
              <a className="school-btn school-btn--primary" href="#visit">
                Book an open morning
              </a>
              <a className="school-btn school-btn--ghost" href="#academics">
                Explore the curriculum
              </a>
            </div>
          </div>

          <aside className="school-hero__card" aria-label="This term at Wrenfield">
            <p className="school-card__kicker">This term</p>
            <ul className="school-dates">
              <li>
                <span className="school-dates__day">02 Sep</span>
                <span>Michaelmas term begins</span>
              </li>
              <li>
                <span className="school-dates__day">14 Nov</span>
                <span>Whole-school open morning</span>
              </li>
              <li>
                <span className="school-dates__day">12 Dec</span>
                <span>Winter concert, Great Hall</span>
              </li>
              <li>
                <span className="school-dates__day">17 Dec</span>
                <span>Carol service, St Mary's</span>
              </li>
            </ul>
            <p className="school-card__note">
              Visitors are welcome throughout the year. The registrar replies
              to every enquiry within two working days.
            </p>
          </aside>
        </section>

        <section className="school-stats" aria-label="Wrenfield at a glance">
          <dl>
            <div>
              <dt>Pupils</dt>
              <dd>1,240</dd>
            </div>
            <div>
              <dt>Pupil–teacher ratio</dt>
              <dd>8:1</dd>
            </div>
            <div>
              <dt>A*–B at A Level</dt>
              <dd>96%</dd>
            </div>
            <div>
              <dt>Clubs &amp; societies</dt>
              <dd>38</dd>
            </div>
          </dl>
        </section>

        <section id="about" className="school-section school-welcome">
          <div className="school-welcome__copy">
            <p className="school-eyebrow">Welcome</p>
            <h2>A word from the Head</h2>
            <p>
              We believe education is a conversation, not a transaction. Our
              pupils are encouraged to ask better questions, to read widely,
              and to take real pleasure in getting things right. Small classes
              and a generous tutorial system mean every pupil is known, and
              every pupil is stretched.
            </p>
            <p>
              Beyond the classroom, Wrenfield offers a full programme of music,
              drama, sport, and service. It is a school that prizes effort as
              much as achievement, and kindness as much as confidence.
            </p>
            <p className="school-signature">
              Dr Eleanor Hart <span>Head of School</span>
            </p>
          </div>

          <blockquote className="school-quote">
            <p>
              Education is not the filling of a pail, but the lighting of a
              fire.
            </p>
            <footer>
              Attributed to W. B. Yeats · carved above the library door
            </footer>
          </blockquote>
        </section>

        <section id="academics" className="school-section">
          <div className="school-section__head">
            <div>
              <p className="school-eyebrow">Academic life</p>
              <h2>Three schools, one community</h2>
            </div>
            <p className="school-section__aside">
              A broad curriculum from Year 7 to Upper Sixth, taught in classes
              of no more than eighteen.
            </p>
          </div>

          <div className="school-cards">
            <article className="school-card">
              <p className="school-card__eyebrow">Ages 11–13</p>
              <h3>Lower School</h3>
              <p>
                A broad foundation in English, mathematics, the sciences,
                languages, and the humanities, with music and games every week.
              </p>
              <a href="#academics">Lower School curriculum</a>
            </article>
            <article className="school-card">
              <p className="school-card__eyebrow">Ages 13–16</p>
              <h3>Middle School</h3>
              <p>
                Pupils begin IGCSE courses with a core of English, mathematics,
                and science, then choose four further subjects of their own.
              </p>
              <a href="#academics">IGCSE subjects</a>
            </article>
            <article className="school-card">
              <p className="school-card__eyebrow">Ages 16–18</p>
              <h3>Sixth Form</h3>
              <p>
                A Level study alongside the Wrenfield Diploma: an extended
                essay, a service placement, and a public presentation in the
                final year.
              </p>
              <a href="#academics">Sixth Form programme</a>
            </article>
          </div>
        </section>

        <section id="news" className="school-section school-news">
          <div className="school-section__head">
            <div>
              <p className="school-eyebrow">Notices</p>
              <h2>News &amp; events</h2>
            </div>
            <a className="school-more" href="#news">
              All news <span aria-hidden="true">→</span>
            </a>
          </div>

          <ul className="school-news__list">
            <li>
              <p className="school-news__date">12 October</p>
              <h3>Sixth Form team reach national debate final</h3>
              <p>
                Four pupils will represent the school at the final in
                Edinburgh next spring.
              </p>
            </li>
            <li>
              <p className="school-news__date">3 October</p>
              <h3>New observatory opens above the science block</h3>
              <p>
                The gift of a former pupil, the telescope will be used by the
                astronomy society and by visiting primary schools.
              </p>
            </li>
            <li>
              <p className="school-news__date">24 September</p>
              <h3>Harvest appeal raises £8,400 for local charities</h3>
              <p>
                Thank you to every family who contributed food, time, and
                generosity.
              </p>
            </li>
          </ul>
        </section>

        <section id="visit" className="school-visit">
          <div className="school-visit__copy">
            <p className="school-eyebrow">Visit us</p>
            <h2>Come and see Wrenfield for yourself</h2>
            <p>
              Open mornings begin at 9.30am with a welcome from the Head,
              followed by tours led by current pupils and refreshments in the
              Great Hall. Individual visits can be arranged on any school day.
            </p>
            <a className="school-btn school-btn--gold" href="#visit">
              Reserve a place
            </a>
          </div>

          <address className="school-visit__card">
            <p className="school-card__kicker">Find us</p>
            <p>
              <strong>Wrenfield Academy</strong>
              <br />
              18 Larkspur Lane
              <br />
              Wrenfield, WR7 4QA
            </p>
            <p>
              <a href="#visit">+44 (0)1632 555 014</a>
              <br />
              <a href="#visit">admissions@wrenfield.example</a>
            </p>
            <p className="school-card__note">Term-time office: 8.00am – 5.30pm</p>
          </address>
        </section>
      </main>

      <footer className="school-footer">
        <p>© 2026 Wrenfield Academy · Registered charity no. 1042771</p>
        <nav aria-label="Footer">
          <a href="#about">About</a>
          <a href="#academics">Academics</a>
          <a href="#visit">Admissions</a>
          <a href="#news">News</a>
        </nav>
      </footer>
    </div>
  );
}
