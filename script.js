/* ==========================================================
   Smart Library System – IoT | script.js
   Vanilla ES6+. Camera access needs HTTPS or localhost.
   Role-based login: Student / Librarian (librarian sign-up uses an access code).
   ========================================================== */
(() => {
  'use strict';

  /* ==========================================================
     A. CONFIG & STATE
     ========================================================== */
  const CONFIG = {
    LOAN_DAYS: 30,
    FINE_PER_DAY: 2, // ₹ per overdue day
    QR_PREFIX: 'LIB-',
    SUPABASE_URL: 'https://tcmtbopnjhteznblqkqk.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRjbXRib3Buamh0ZXpuYmxxa3FrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1NjU3OTEsImV4cCI6MjEwODE0MTc5MX0.1tn1ec0_vfegGYBW4AoDdTwY0_LTiVde99EKa6I34p0'
  };
  const MAX_BACKDATE_DAYS = 7;
  const TABS = ['student', 'librarian', 'qrgrid'];
  // Which tabs each role may open (the database enforces this too via RLS)
  const ROLE_TABS = { student: ['student'], librarian: ['librarian', 'qrgrid'] };
  const ROLE_LABEL = { student: 'Student', librarian: 'Librarian' };

  const state = {
    books: [],
    issues: [],
    currentBook: null,
    scannerInstance: {}, // containerId -> Html5Qrcode
    activeTab: 'student',
    user: null // { id, email, name, role } when logged in
  };
  const authUI = { role: 'student', mode: 'login' };

  // TODO: SUPABASE – client creation. Falls back to localStorage demo mode when
  // the CDN failed to load or the URL is still the placeholder.
  const supabaseClient =
    window.supabase &&
    typeof window.supabase.createClient === 'function' &&
    CONFIG.SUPABASE_URL &&
    CONFIG.SUPABASE_URL !== 'YOUR_SUPABASE_URL'
      ? window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY)
      : null;

  const $ = (id) => document.getElementById(id);

  /* ==========================================================
     C. UTILITIES (declared early so the data layer can use them)
     ========================================================== */
  const generateBookId = () =>
    CONFIG.QR_PREFIX +
    Date.now().toString(36).toUpperCase() +
    Math.random().toString(36).slice(2, 5).toUpperCase();

  const generateIssueId = () =>
    'ISS-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 4).toUpperCase();

  const formatDate = (d) => {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };
  const parseLocal = (s) => {
    const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const addDays = (date, n) => {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  };
  const daysBetween = (a, b) =>
    Math.round((new Date(b).setHours(0, 0, 0, 0) - new Date(a).setHours(0, 0, 0, 0)) / 86400000);

  const escapeHTML = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

  const debounce = (fn, ms = 250) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  const stars = (rating) => {
    const r = Number(rating) || 0;
    const n = Math.max(0, Math.min(5, Math.round(r)));
    return '★'.repeat(n) + '☆'.repeat(5 - n) + ' ' + r.toFixed(1);
  };

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function showToast(message, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    $('toast-container').appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  // Disable a button and show a spinner while an async task runs
  async function withBusy(btn, task) {
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Please wait…';
    try { return await task(); }
    finally { btn.disabled = false; btn.innerHTML = original; }
  }

  // Promise-based confirmation modal with focus trap; restores focus on close
  function confirmModal(title, message, confirmText = 'Confirm') {
    return new Promise((resolve) => {
      const modal = $('modal');
      const previous = document.activeElement;
      $('modal-title').textContent = title;
      $('modal-message').textContent = message;
      $('modal-confirm').textContent = confirmText;
      modal.classList.remove('hidden');
      $('modal-cancel').focus();

      const onKey = (e) => {
        if (e.key === 'Escape') close(false);
        if (e.key === 'Tab') {
          e.preventDefault();
          const f = [$('modal-cancel'), $('modal-confirm')];
          const i = f.indexOf(document.activeElement);
          f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
        }
      };
      const onOk = () => close(true);
      const onNo = () => close(false);
      function close(value) {
        modal.classList.add('hidden');
        $('modal-confirm').removeEventListener('click', onOk);
        $('modal-cancel').removeEventListener('click', onNo);
        document.removeEventListener('keydown', onKey);
        if (previous && previous.focus) previous.focus();
        resolve(value);
      }
      $('modal-confirm').addEventListener('click', onOk);
      $('modal-cancel').addEventListener('click', onNo);
      document.addEventListener('keydown', onKey);
    });
  }

  /* ==========================================================
     B. DATA LAYER
     Two interchangeable implementations behind one `api` object.
     UI code only ever calls `api` (including api.auth).
     ========================================================== */

  /* ---------- localStorage demo implementation ---------- */
  const LS_BOOKS = 'sls_books';
  const LS_ISSUES = 'sls_issues';
  const LS_SEEDED = 'sls_seeded';
  const LS_USERS = 'sls_users';
  const SS_SESSION = 'sls_session';
  const readLS = (k) => { try { return JSON.parse(localStorage.getItem(k)) || []; } catch { return []; } };
  const writeLS = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  const seedBooks = () => [
    ['Introduction to Algorithms', 'Cormen et al.', 'Computer Science', 'Discrete Mathematics', 4.7, 3],
    ['Operating System Concepts', 'Silberschatz', 'Computer Science', 'Data Structures', 4.4, 2],
    ['Database System Concepts', 'Korth', 'Computer Science', 'Basic Programming', 4.2, 4],
    ['Digital Design', 'M. Morris Mano', 'Electronics', 'Basic Electronics', 4.3, 2],
    ['Microelectronic Circuits', 'Sedra & Smith', 'Electronics', 'Circuit Theory', 4.5, 1],
    ['Engineering Thermodynamics', 'P.K. Nag', 'Mechanical', 'Physics', 4.0, 3],
    ['Strength of Materials', 'R.K. Bansal', 'Civil', 'Engineering Mechanics', 3.9, 2],
    ['Advanced Engineering Mathematics', 'Erwin Kreyszig', 'Mathematics', 'Calculus', 4.6, 5],
    ['Concepts of Physics', 'H.C. Verma', 'Physics', 'None', 4.8, 3],
    ['Computer Networks', 'A. Tanenbaum', 'Computer Science', 'Operating Systems', 4.1, 2]
  ].map((b, i) => ({
    id: `${CONFIG.QR_PREFIX}${String(i + 1).padStart(4, '0')}`,
    title: b[0], author: b[1], category: b[2], prerequisites: b[3],
    rating: b[4], totalCopies: b[5], availableCopies: b[5]
  }));

  // DEMO ONLY: plain-text passwords in localStorage are NOT secure.
  // Real authentication happens through Supabase Auth when connected.
  const DEMO_ACCOUNTS = {
    student: { email: 'student@demo.com', password: 'student123' },
    librarian: { email: 'librarian@demo.com', password: 'librarian123' }
  };
  const DEMO_LIBRARIAN_CODE = 'LIB-ADMIN-2026'; // demo mode only; the real code lives in the database
  const localUsers = () => {
    let users = readLS(LS_USERS);
    if (!users.length) {
      users = [
        { id: 'u-student', email: DEMO_ACCOUNTS.student.email, password: DEMO_ACCOUNTS.student.password, role: 'student', name: 'Demo Student' },
        { id: 'u-librarian', email: DEMO_ACCOUNTS.librarian.email, password: DEMO_ACCOUNTS.librarian.password, role: 'librarian', name: 'Demo Librarian' }
      ];
      writeLS(LS_USERS, users);
    }
    return users;
  };
  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

  const localApi = {
    auth: {
      async signIn(email, password) {
        const u = localUsers().find((x) => x.email === email.toLowerCase() && x.password === password);
        if (!u) throw new Error('Invalid email or password.');
        sessionStorage.setItem(SS_SESSION, u.id);
        return publicUser(u);
      },
      async signUp(name, email, password, code = '') {
        const users = localUsers();
        if (users.some((x) => x.email === email.toLowerCase())) throw new Error('An account with this email already exists.');
        if (code && code !== DEMO_LIBRARIAN_CODE) throw new Error('Invalid librarian access code.');
        const u = { id: 'u-' + Date.now().toString(36), email: email.toLowerCase(), password, role: code ? 'librarian' : 'student', name };
        users.push(u);
        writeLS(LS_USERS, users);
        sessionStorage.setItem(SS_SESSION, u.id);
        return { user: publicUser(u) };
      },
      async signOut() { sessionStorage.removeItem(SS_SESSION); },
      async getCurrentUser() {
        const id = sessionStorage.getItem(SS_SESSION);
        const u = id && localUsers().find((x) => x.id === id);
        return u ? publicUser(u) : null;
      }
    },
    async getBooks() {
      let books = readLS(LS_BOOKS);
      if (!books.length && !localStorage.getItem(LS_SEEDED)) {
        books = seedBooks();
        writeLS(LS_BOOKS, books);
        localStorage.setItem(LS_SEEDED, '1');
      }
      return books.sort((a, b) => a.title.localeCompare(b.title));
    },
    async getBookById(id) {
      const key = String(id).trim().toLowerCase();
      return readLS(LS_BOOKS).find((b) => b.id.toLowerCase() === key) || null;
    },
    async addBook(book) {
      const books = readLS(LS_BOOKS);
      books.push(book);
      writeLS(LS_BOOKS, books);
      return book;
    },
    async deleteBook(id) {
      writeLS(LS_BOOKS, readLS(LS_BOOKS).filter((b) => b.id !== id));
      writeLS(LS_ISSUES, readLS(LS_ISSUES).filter((i) => i.bookId !== id));
    },
    async issueBook(issue) {
      const books = readLS(LS_BOOKS);
      const book = books.find((b) => b.id === issue.bookId);
      if (!book || book.availableCopies < 1) throw new Error('No copies available');
      book.availableCopies -= 1;
      writeLS(LS_BOOKS, books);
      const issues = readLS(LS_ISSUES);
      issues.push(issue);
      writeLS(LS_ISSUES, issues);
      return issue;
    },
    async getIssues() {
      const all = readLS(LS_ISSUES);
      // Students only see their own records (Supabase does this with RLS)
      return state.user && state.user.role === 'student' ? all.filter((i) => i.userId === state.user.id) : all;
    },
    async returnBook(issueId) {
      const issues = readLS(LS_ISSUES);
      const issue = issues.find((i) => i.id === issueId && i.status === 'issued');
      if (!issue) throw new Error('Active issue not found');
      issue.status = 'returned';
      issue.returnedOn = formatDate(new Date());
      writeLS(LS_ISSUES, issues);
      const books = readLS(LS_BOOKS);
      const book = books.find((b) => b.id === issue.bookId);
      if (book) {
        book.availableCopies = Math.min(book.totalCopies, book.availableCopies + 1);
        writeLS(LS_BOOKS, books);
      }
      return issue;
    }
  };

  /* ---------- Supabase live implementation ---------- */
  // TODO: SUPABASE – role lives in the `profiles` table (set by the DB trigger, never by the browser)
  async function fetchProfile(uid, fallbackEmail) {
    const { data, error } = await supabaseClient
      .from('profiles').select('role, full_name, email').eq('id', uid).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Profile not found. Please try again in a moment.');
    return { id: uid, email: data.email || fallbackEmail, name: data.full_name || '', role: data.role };
  }

  const supabaseApi = {
    auth: {
      async signIn(email, password) {
        // TODO: SUPABASE – email + password login
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw new Error(error.message);
        try { return await fetchProfile(data.user.id, data.user.email); }
        catch (e) { await supabaseClient.auth.signOut(); throw e; }
      },
      async signUp(name, email, password, code = '') {
        // TODO: SUPABASE – the DB trigger compares `code` with app_settings.librarian_code.
        // Correct code => 'librarian', otherwise => 'student'.
        const { data, error } = await supabaseClient.auth.signUp({
          email, password,
          options: { data: { full_name: name, librarian_code: code } }
        });
        if (error) throw new Error(error.message);
        if (!data.session) return { needsConfirmation: true }; // email confirmation is enabled
        return { user: await fetchProfile(data.user.id, data.user.email) };
      },
      async signOut() {
        // TODO: SUPABASE
        await supabaseClient.auth.signOut();
      },
      async getCurrentUser() {
        // TODO: SUPABASE – restore session after a page reload
        const { data } = await supabaseClient.auth.getSession();
        if (!data.session) return null;
        try { return await fetchProfile(data.session.user.id, data.session.user.email); }
        catch (e) { return null; }
      }
    },
    async getBooks() {
      // TODO: SUPABASE – select * from books order by title
      const { data, error } = await supabaseClient.from('books').select('*').order('title');
      if (error) throw error;
      return data || [];
    },
    async getBookById(id) {
      // TODO: SUPABASE – single row by id (exact first, then case-insensitive)
      const clean = String(id).trim();
      let res = await supabaseClient.from('books').select('*').eq('id', clean).maybeSingle();
      if (res.error) throw res.error;
      if (res.data) return res.data;
      const escaped = clean.replace(/[\\%_]/g, (c) => '\\' + c);
      res = await supabaseClient.from('books').select('*').ilike('id', escaped).limit(1).maybeSingle();
      if (res.error) throw res.error;
      return res.data || null;
    },
    async addBook(book) {
      // TODO: SUPABASE – insert into books (librarians only, enforced by RLS)
      const { data, error } = await supabaseClient.from('books').insert(book).select().single();
      if (error) throw error;
      return data;
    },
    async deleteBook(id) {
      // TODO: SUPABASE – delete from books (librarians only; issues cascade)
      const { error } = await supabaseClient.from('books').delete().eq('id', id);
      if (error) throw error;
    },
    async issueBook(issue) {
      // TODO: SUPABASE – atomic RPC: inserts the issue (userId = auth.uid()) and decrements availableCopies
      const { data, error } = await supabaseClient.rpc('issue_book', {
        p_id: issue.id,
        p_book_id: issue.bookId,
        p_book_title: issue.bookTitle,
        p_student_name: issue.studentName,
        p_enrollment_no: issue.enrollmentNo,
        p_roll_no: issue.rollNo,
        p_branch: issue.branch,
        p_semester: issue.semester,
        p_email: issue.email,
        p_issue_date: issue.issueDate,
        p_due_date: issue.dueDate
      });
      if (error) throw new Error(error.message || 'Could not issue the book');
      return data;
    },
    async getIssues() {
      // TODO: SUPABASE – RLS returns all rows for librarians, only own rows for students
      const { data, error } = await supabaseClient
        .from('issues').select('*').order('created_at', { ascending: true });
      if (error) throw error;
      return data || [];
    },
    async returnBook(issueId) {
      // TODO: SUPABASE – atomic RPC (librarians only): marks returned and increments availableCopies
      const { data, error } = await supabaseClient.rpc('return_book', { p_issue_id: issueId });
      if (error) throw new Error(error.message || 'Could not process the return');
      return data;
    }
  };

  // Single entry point used by all UI code
  const api = supabaseClient ? supabaseApi : localApi;

  async function refreshData() {
    state.books = await api.getBooks();
    state.issues = await api.getIssues();
  }

  /* ==========================================================
     L. AUTHENTICATION (login screen + role-based access)
     ========================================================== */
  function setAuthError(msg) {
    const el = $('auth-error');
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }

  function renderAuthUI() {
    const { role, mode } = authUI;
    const signup = mode === 'signup';
    const librarianSignup = signup && role === 'librarian';

    document.querySelectorAll('.role-btn').forEach((b) => {
      const on = b.dataset.role === role;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    $('auth-title').textContent = signup ? `Create ${role} account` : `${ROLE_LABEL[role]} login`;
    $('auth-submit').textContent = signup ? 'Create Account' : 'Login';
    $('auth-name-wrap').classList.toggle('hidden', !signup);
    $('auth-name').required = signup;
    $('auth-code-wrap').classList.toggle('hidden', !librarianSignup);
    $('auth-code').required = librarianSignup;
    $('auth-password').autocomplete = signup ? 'new-password' : 'current-password';
    $('auth-toggle-wrap').classList.remove('hidden');
    $('auth-toggle-mode').textContent = signup
      ? 'Already have an account? Log in'
      : `New ${role}? Create an account`;

    const hint = $('auth-hint');
    if (!supabaseClient) {
      const d = DEMO_ACCOUNTS[role];
      hint.textContent = librarianSignup
        ? `Demo mode – access code: ${DEMO_LIBRARIAN_CODE}`
        : `Demo mode – try ${d.email} / ${d.password}`;
      hint.classList.remove('hidden');
    } else if (librarianSignup) {
      hint.textContent = 'Ask your administrator for the Librarian Access Code.';
      hint.classList.remove('hidden');
    } else {
      hint.classList.add('hidden');
    }
    setAuthError('');
  }

  async function submitAuth(e) {
    e.preventDefault();
    const form = e.target;
    form.querySelectorAll('input').forEach((el) => el.classList.add('touched'));
    setAuthError('');

    const signup = authUI.mode === 'signup';
    const librarianSignup = signup && authUI.role === 'librarian';
    const name = $('auth-name').value.trim();
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    const code = $('auth-code').value.trim();

    if (signup && !name) { setAuthError('Please enter your full name.'); $('auth-name').focus(); return; }
    if (!EMAIL_RE.test(email)) { setAuthError('Please enter a valid email address.'); $('auth-email').focus(); return; }
    if (password.length < 6) { setAuthError('Password must be at least 6 characters.'); $('auth-password').focus(); return; }
    if (librarianSignup && !code) { setAuthError('Please enter the Librarian Access Code.'); $('auth-code').focus(); return; }

    try {
      const outcome = await withBusy($('auth-submit'), async () => {
        let user;
        if (signup) {
          const res = await api.auth.signUp(name, email, password, librarianSignup ? code : '');
          if (res.needsConfirmation) return 'confirm';
          user = res.user;
        } else {
          user = await api.auth.signIn(email, password);
        }
        // The chosen portal must match the account's role
        if (user.role !== authUI.role) {
          await api.auth.signOut();
          if (librarianSignup) {
            throw new Error('Wrong access code. A student account was created instead; log in with the Student option.');
          }
          throw new Error(`This is a ${ROLE_LABEL[user.role].toLowerCase()} account. Please choose the ${ROLE_LABEL[user.role]} option to log in.`);
        }
        await enterApp(user);
        return 'ok';
      });
      if (outcome === 'confirm') {
        authUI.mode = 'login';
        renderAuthUI();
        showToast('Account created. Check your email to confirm it, then log in.', 'success');
      }
    } catch (err) {
      setAuthError(err.message || 'Login failed. Please try again.');
    }
  }

  async function enterApp(user) {
    state.user = user;
    const tabs = ROLE_TABS[user.role] || ROLE_TABS.student;

    $('user-chip').textContent = `${user.role === 'librarian' ? '🧑‍💼' : '🎓'} ${user.name || user.email}`;
    $('user-chip').title = `${user.email} (${ROLE_LABEL[user.role]})`;
    $('user-chip').classList.remove('hidden');
    $('logout-btn').classList.remove('hidden');
    $('auth-screen').classList.add('hidden');
    $('app-content').classList.remove('hidden');

    TABS.forEach((t) => $(`tab-${t}`).classList.toggle('hidden', !tabs.includes(t)));
    $('app-nav').classList.toggle('hidden', tabs.length < 2);
    document.body.classList.toggle('has-nav', tabs.length > 1);

    prefillStudent();
    try { await refreshData(); }
    catch (err) {
      console.error(err);
      showToast('Could not load data. Check your connection and Supabase setup.', 'error');
    }
    const wanted = location.hash.slice(1);
    switchTab(tabs.includes(wanted) ? wanted : tabs[0], { focus: true });
    renderAll();
  }

  function exitApp() {
    stopAllScanners();
    state.user = null;
    state.books = [];
    state.issues = [];
    state.currentBook = null;
    returnTarget = null;

    ['book-panel', 'issue-section', 'issue-confirmation', 'return-record', 'qr-result'].forEach((id) => $(id).classList.add('hidden'));
    $('app-content').classList.add('hidden');
    $('app-nav').classList.add('hidden');
    document.body.classList.remove('has-nav');
    $('user-chip').classList.add('hidden');
    $('logout-btn').classList.add('hidden');
    $('auth-screen').classList.remove('hidden');
    $('auth-password').value = '';
    $('auth-code').value = '';
    $('auth-form').querySelectorAll('.touched').forEach((el) => el.classList.remove('touched'));
    history.replaceState(null, '', location.pathname + location.search);
    authUI.mode = 'login';
    renderAuthUI();
    $('auth-email').focus({ preventScroll: true });
  }

  async function logout() {
    try { await api.auth.signOut(); } catch (err) { console.error(err); }
    exitApp();
    showToast('You have been logged out.', 'info');
  }

  // Pre-fill the issue form with the logged-in student's details
  function prefillStudent() {
    if (!state.user || state.user.role !== 'student') return;
    $('student-name').value = state.user.name || '';
    $('email').value = state.user.email || '';
  }

  /* ==========================================================
     D. NAVIGATION
     ========================================================== */
  const allowedTabs = () => (state.user ? ROLE_TABS[state.user.role] : []);

  function switchTab(name, { focus = false, updateHash = true } = {}) {
    const tabs = allowedTabs();
    if (!tabs.length) return;
    if (!tabs.includes(name)) name = tabs[0];
    stopAllScanners();
    state.activeTab = name;
    TABS.forEach((t) => {
      const btn = $(`tab-${t}`);
      const on = t === name;
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
      $(`panel-${t}`).classList.toggle('hidden', !on);
    });
    if (updateHash && location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
    if (name === 'qrgrid') renderQRGrid();
    if (focus) $(`panel-${name}`).focus({ preventScroll: true });
  }

  function bindNavigation() {
    const list = document.querySelector('.tablist');
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (btn) switchTab(btn.dataset.tab, { focus: true });
    });
    list.addEventListener('keydown', (e) => {
      const tabs = allowedTabs();
      const i = tabs.indexOf(state.activeTab);
      let next = null;
      if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next !== null) {
        e.preventDefault();
        switchTab(tabs[next]);
        $(`tab-${tabs[next]}`).focus();
      }
    });
    window.addEventListener('hashchange', () => {
      if (state.user) switchTab(location.hash.slice(1), { updateHash: false });
    });

    // Librarian sub-tabs
    document.querySelector('.subtabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-subtab]');
      if (!btn) return;
      stopAllScanners();
      document.querySelectorAll('.subtab-btn').forEach((x) => {
        const on = x === btn;
        x.classList.toggle('active', on);
        x.setAttribute('aria-pressed', String(on));
      });
      $('sub-manage').classList.toggle('hidden', btn.dataset.subtab !== 'manage');
      $('sub-return').classList.toggle('hidden', btn.dataset.subtab !== 'return');
    });
  }

  /* ==========================================================
     E. QR SCANNER (html5-qrcode)
     ========================================================== */
  async function stopScanner(containerId) {
    const inst = state.scannerInstance[containerId];
    if (!inst) return;
    delete state.scannerInstance[containerId];
    try {
      const running = typeof inst.getState === 'function' ? inst.getState() === 2 : true;
      if (running) await inst.stop();
      inst.clear();
    } catch (e) { /* scanner already stopped */ }
  }
  function stopAllScanners() {
    Object.keys(state.scannerInstance).forEach((id) => { stopScanner(id); });
  }

  // Reusable: start scanning inside `containerId`, call `onDecode(text)` once per scan
  async function startScanner(containerId, onDecode) {
    if (typeof Html5Qrcode === 'undefined') {
      showToast('Scanner library failed to load. Use manual entry.', 'error');
      return;
    }
    await stopScanner(containerId);
    const inst = new Html5Qrcode(containerId);
    state.scannerInstance[containerId] = inst;

    const width = $(containerId).clientWidth || 300;
    const size = Math.max(150, Math.min(320, Math.floor(width * 0.7)));
    const config = { fps: 10, qrbox: { width: size, height: size } };

    let lastScan = 0;
    const onSuccess = async (text) => {
      const now = Date.now();
      if (now - lastScan < 2500) return; // process each scan once
      lastScan = now;
      await stopScanner(containerId);
      onDecode(text);
    };
    const onFrameError = () => {}; // ignore "no QR in frame" noise

    try {
      try {
        await inst.start({ facingMode: { exact: 'environment' } }, config, onSuccess, onFrameError);
      } catch (firstError) {
        await inst.start({ facingMode: 'environment' }, config, onSuccess, onFrameError);
      }
    } catch (err) {
      delete state.scannerInstance[containerId];
      const denied = /permission|denied|NotAllowed/i.test(String(err));
      showToast(
        denied
          ? 'Camera permission denied. Allow camera access or enter the Book ID manually.'
          : 'Could not start the camera (needs HTTPS or localhost). Use manual entry instead.',
        'error'
      );
    }
  }

  // Accepts a plain Book ID or JSON like {"id": "...", "type": "book"}
  function parsePayload(text) {
    const t = String(text || '').trim();
    try {
      const obj = JSON.parse(t);
      if (obj && obj.id) return String(obj.id).trim();
    } catch (e) { /* plain ID */ }
    return t;
  }

  async function handleStudentLookup(raw) {
    const id = parsePayload(raw);
    if (!id) { showToast('Please enter a Book ID.', 'warning'); return; }
    try {
      const book = await api.getBookById(id);
      if (!book) { showToast('Book not found', 'error'); return; }
      state.currentBook = book;
      renderBookInfo(book);
    } catch (err) {
      showToast('Lookup failed. Please try again.', 'error');
    }
  }

  /* ==========================================================
     F. BOOK INFO PANEL
     ========================================================== */
  function renderBookInfo(book) {
    $('info-title').textContent = book.title;
    $('info-id').textContent = book.id;
    $('info-category').textContent = book.category;
    $('info-prereq').textContent = book.prerequisites || 'None';
    $('info-rating').textContent = stars(book.rating);

    const available = Number(book.availableCopies) > 0;
    const badge = $('info-availability');
    badge.textContent = available ? `Available (${book.availableCopies})` : 'Issued';
    badge.className = `badge ${available ? 'badge-success' : 'badge-danger'}`;
    $('proceed-issue').disabled = !available;

    $('issue-section').classList.add('hidden');
    $('issue-confirmation').classList.add('hidden');
    $('book-panel').classList.remove('hidden');
    $('book-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ==========================================================
     G. ISSUE FORM
     ========================================================== */
  function setupIssueForm() {
    const sem = $('semester');
    for (let i = 1; i <= 8; i++) sem.insertAdjacentHTML('beforeend', `<option value="${i}">Semester ${i}</option>`);
    resetIssueDates();
  }
  function resetIssueDates() {
    const today = new Date();
    const dateInput = $('issue-date');
    dateInput.min = formatDate(addDays(today, -MAX_BACKDATE_DAYS));
    dateInput.max = formatDate(today);
    dateInput.value = formatDate(today);
    updateReturnDate();
  }
  function updateReturnDate() {
    const v = $('issue-date').value;
    $('return-date').value = v ? formatDate(addDays(parseLocal(v), CONFIG.LOAN_DAYS)) : '';
  }
  function showIssueForm() {
    const book = state.currentBook;
    if (!book) return;
    $('issue-summary').innerHTML =
      `<p><strong>${escapeHTML(book.title)}</strong></p>` +
      `<p>ID: ${escapeHTML(book.id)} · ${escapeHTML(book.category)} · ${escapeHTML(book.author || '')}</p>`;
    $('issue-section').classList.remove('hidden');
    $('issue-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('enrollment-no').focus({ preventScroll: true });
  }

  async function submitIssue(e) {
    e.preventDefault();
    const form = e.target;
    form.querySelectorAll('input, select').forEach((el) => el.classList.add('touched'));
    const val = (id) => $(id).value.trim();

    if (!state.user) { showToast('Please log in first.', 'warning'); return; }
    if (!state.currentBook) { showToast('Scan or look up a book first.', 'warning'); return; }
    if (!form.checkValidity()) {
      showToast('Please fill all required fields correctly.', 'warning');
      const bad = form.querySelector(':invalid');
      if (bad) bad.focus();
      return;
    }
    if (!EMAIL_RE.test(val('email'))) {
      showToast('Enter a valid email address.', 'warning');
      $('email').focus();
      return;
    }
    const diff = daysBetween(parseLocal(val('issue-date')), new Date());
    if (diff > MAX_BACKDATE_DAYS || diff < 0) {
      showToast(`Issue date must be within the last ${MAX_BACKDATE_DAYS} days and not in the future.`, 'warning');
      return;
    }

    const record = {
      id: generateIssueId(),
      bookId: state.currentBook.id,
      bookTitle: state.currentBook.title,
      studentName: val('student-name'),
      enrollmentNo: val('enrollment-no'),
      rollNo: val('roll-no'),
      branch: val('branch'),
      semester: val('semester'),
      email: val('email'),
      issueDate: val('issue-date'),
      dueDate: val('return-date'),
      status: 'issued',
      userId: state.user.id // used by demo mode; Supabase sets userId = auth.uid() on the server
    };

    try {
      await withBusy($('issue-submit'), () => api.issueBook(record));
      showToast('Book issued successfully!', 'success');

      const box = $('issue-confirmation');
      box.innerHTML =
        `<h2>✔ Book Issued</h2>` +
        `<p><strong>${escapeHTML(record.bookTitle)}</strong> (${escapeHTML(record.bookId)})</p>` +
        `<p>Student: ${escapeHTML(record.studentName)} · ${escapeHTML(record.enrollmentNo)}</p>` +
        `<p>Issue ID: ${escapeHTML(record.id)}</p>` +
        `<p>Return by: <strong>${escapeHTML(record.dueDate)}</strong></p>`;

      form.reset();
      form.querySelectorAll('.touched').forEach((el) => el.classList.remove('touched'));
      resetIssueDates();
      prefillStudent();
      state.currentBook = null;
      $('book-panel').classList.add('hidden');
      $('issue-section').classList.add('hidden');
      box.classList.remove('hidden');
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
      box.focus({ preventScroll: true });

      await refreshData();
      renderAll();
    } catch (err) {
      showToast(err.message || 'Could not issue the book.', 'error');
    }
  }

  function renderMyIssues() {
    const today = new Date();
    const rows = [...state.issues].reverse();
    $('my-issues-body').innerHTML = rows.length
      ? rows.map((i) => {
          const overdue = i.status === 'issued' && daysBetween(parseLocal(i.dueDate), today) > 0;
          const label = i.status === 'returned' ? 'Returned' : overdue ? 'Overdue' : 'Issued';
          const cls = i.status === 'returned' ? 'badge-success' : overdue ? 'badge-danger' : 'badge-warning';
          return `<tr class="${overdue ? 'overdue' : ''}">
            <td data-label="Book">${escapeHTML(i.bookTitle)}</td>
            <td data-label="Issued">${escapeHTML(i.issueDate)}</td>
            <td data-label="Due">${escapeHTML(i.dueDate)}</td>
            <td data-label="Status"><span class="badge ${cls}">${label}</span></td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="4" class="empty">You have not issued any books yet.</td></tr>';
  }

  /* ==========================================================
     H. LIBRARIAN: ADD BOOK + QR GENERATOR
     ========================================================== */
  function makeQR(container, payload, size) {
    container.innerHTML = '';
    if (typeof QRCode === 'undefined') {
      container.textContent = 'QR library unavailable';
      return;
    }
    new QRCode(container, { text: payload, width: size, height: size, correctLevel: QRCode.CorrectLevel.M });
  }
  const bookPayload = (b) => JSON.stringify({ id: b.id, title: b.title, type: 'book' });

  async function submitAddBook(e) {
    e.preventDefault();
    const form = e.target;
    form.querySelectorAll('input, select').forEach((el) => el.classList.add('touched'));

    const catValue = $('book-category').value;
    const category = catValue === '__custom' ? $('book-category-custom').value.trim() : catValue;
    const title = $('book-title').value.trim();
    const author = $('book-author').value.trim();
    const rating = parseFloat($('book-rating').value);
    const copies = parseInt($('book-copies').value, 10);

    if (!title || !author || !category || Number.isNaN(rating) || rating < 0 || rating > 5 || !(copies >= 1)) {
      showToast('Please complete all fields (rating 0–5, copies ≥ 1).', 'warning');
      return;
    }

    const book = {
      id: generateBookId(),
      title,
      author,
      category,
      prerequisites: $('book-prereq').value.trim() || 'None',
      rating: Math.round(rating * 10) / 10,
      totalCopies: copies,
      availableCopies: copies
    };

    try {
      await withBusy($('add-book-submit'), () => api.addBook(book));
      $('new-book-id').textContent = book.id;
      $('qr-result').classList.remove('hidden');
      makeQR($('qr-preview'), bookPayload(book), 200);
      $('download-qr').dataset.id = book.id;
      showToast('Book added and QR generated.', 'success');

      form.reset();
      form.querySelectorAll('.touched').forEach((el) => el.classList.remove('touched'));
      $('custom-category-wrap').classList.add('hidden');
      await refreshData();
      renderAll();
    } catch (err) {
      showToast('Could not add the book. ' + (err.message || ''), 'error');
    }
  }

  function downloadQR() {
    const holder = $('qr-preview');
    const canvas = holder.querySelector('canvas');
    const img = holder.querySelector('img');
    const filename = `${$('download-qr').dataset.id || 'book'}.png`;

    const save = (url, revoke) => {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (revoke) setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    if (canvas && canvas.toBlob) {
      canvas.toBlob((blob) => { if (blob) save(URL.createObjectURL(blob), true); }, 'image/png');
    } else if (img && img.src) {
      save(img.src, false);
    } else {
      showToast('No QR code to download yet.', 'warning');
    }
  }

  function renderInventory() {
    const query = $('inventory-search').value.trim().toLowerCase();
    const sort = $('inventory-sort').value;

    // Refresh category filter options while keeping the current selection
    const categories = [...new Set(state.books.map((b) => b.category))].sort();
    const current = $('inventory-category').value;
    $('inventory-category').innerHTML =
      '<option value="">All categories</option>' +
      categories.map((c) => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join('');
    $('inventory-category').value = categories.includes(current) ? current : '';
    const category = $('inventory-category').value;

    const comparators = {
      title: (a, b) => a.title.localeCompare(b.title),
      category: (a, b) => a.category.localeCompare(b.category),
      rating: (a, b) => b.rating - a.rating,
      available: (a, b) => b.availableCopies - a.availableCopies
    };
    const list = state.books
      .filter((b) => (!category || b.category === category) &&
        (!query || [b.title, b.author, b.id].some((s) => String(s).toLowerCase().includes(query))))
      .sort(comparators[sort] || comparators.title);

    $('inventory-body').innerHTML = list.length
      ? list.map((b) => {
          const ok = Number(b.availableCopies) > 0;
          return `<tr>
            <td data-label="ID">${escapeHTML(b.id)}</td>
            <td data-label="Title">${escapeHTML(b.title)}</td>
            <td data-label="Author">${escapeHTML(b.author)}</td>
            <td data-label="Category">${escapeHTML(b.category)}</td>
            <td data-label="Rating"><span class="stars">${escapeHTML(stars(b.rating))}</span></td>
            <td data-label="Copies">${escapeHTML(b.availableCopies)}/${escapeHTML(b.totalCopies)}</td>
            <td data-label="Status"><span class="badge ${ok ? 'badge-success' : 'badge-danger'}">${ok ? 'Available' : 'Issued'}</span></td>
            <td data-label="Action"><button type="button" class="btn btn-danger btn-sm" data-action="delete" data-id="${escapeHTML(b.id)}">Delete</button></td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="8" class="empty">No books found.</td></tr>';
  }

  async function handleDelete(id) {
    const book = state.books.find((b) => b.id === id);
    if (!book) return;
    const ok = await confirmModal('Delete book?', `Delete "${book.title}" (${book.id}) permanently? Its issue records will also be removed.`, 'Delete');
    if (!ok) return;
    try {
      await api.deleteBook(id);
      showToast('Book deleted.', 'success');
      await refreshData();
      renderAll();
    } catch (err) {
      showToast('Could not delete the book.', 'error');
    }
  }

  /* ==========================================================
     I. LIBRARIAN: RETURN BOOK
     ========================================================== */
  let returnTarget = null;

  async function handleReturnLookup(raw) {
    const id = parsePayload(raw);
    if (!id) { showToast('Enter a Book ID.', 'warning'); return; }
    try {
      await refreshData();
      const issue = state.issues.find(
        (i) => String(i.bookId).toLowerCase() === id.toLowerCase() && i.status === 'issued'
      );
      if (!issue) {
        returnTarget = null;
        $('return-record').classList.add('hidden');
        showToast('No active issue found for that book.', 'error');
        return;
      }
      returnTarget = issue;
      const overdue = Math.max(0, daysBetween(parseLocal(issue.dueDate), new Date()));
      const fine = overdue * CONFIG.FINE_PER_DAY;
      $('return-details').innerHTML =
        `<p><strong>${escapeHTML(issue.bookTitle)}</strong> (${escapeHTML(issue.bookId)})</p>` +
        `<p>Student: ${escapeHTML(issue.studentName)} · ${escapeHTML(issue.enrollmentNo)}</p>` +
        `<p>Issued: ${escapeHTML(issue.issueDate)} · Due: ${escapeHTML(issue.dueDate)}</p>` +
        `<p>Overdue days: <strong>${overdue}</strong> · Fine: <strong>₹${fine}</strong> (₹${CONFIG.FINE_PER_DAY}/day)</p>`;
      $('return-record').classList.remove('hidden');
      $('return-record').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      showToast('Lookup failed. Please try again.', 'error');
    }
  }

  async function confirmReturn() {
    if (!returnTarget) return;
    const ok = await confirmModal(
      'Mark as returned?',
      `Confirm return of "${returnTarget.bookTitle}" from ${returnTarget.studentName}?`,
      'Mark Returned'
    );
    if (!ok) return;
    try {
      await api.returnBook(returnTarget.id);
      showToast('Book returned successfully.', 'success');
      returnTarget = null;
      $('return-record').classList.add('hidden');
      $('return-id').value = '';
      await refreshData();
      renderAll();
    } catch (err) {
      showToast(err.message || 'Could not process the return.', 'error');
    }
  }

  function renderIssues() {
    const today = new Date();
    const rows = [...state.issues].reverse(); // newest first
    $('issues-body').innerHTML = rows.length
      ? rows.map((i) => {
          const overdue = i.status === 'issued' && daysBetween(parseLocal(i.dueDate), today) > 0;
          const label = i.status === 'returned' ? 'Returned' : overdue ? 'Overdue' : 'Issued';
          const cls = i.status === 'returned' ? 'badge-success' : overdue ? 'badge-danger' : 'badge-warning';
          return `<tr class="${overdue ? 'overdue' : ''}">
            <td data-label="Issue ID">${escapeHTML(i.id)}</td>
            <td data-label="Book">${escapeHTML(i.bookTitle)}</td>
            <td data-label="Student">${escapeHTML(i.studentName)}</td>
            <td data-label="Issued">${escapeHTML(i.issueDate)}</td>
            <td data-label="Due">${escapeHTML(i.dueDate)}</td>
            <td data-label="Status"><span class="badge ${cls}">${label}</span></td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="6" class="empty">No issue records yet.</td></tr>';
  }

  /* ==========================================================
     J. PRINTABLE QR GRID
     ========================================================== */
  function renderQRGrid() {
    const grid = $('qr-grid');
    grid.innerHTML = '';
    if (!state.books.length) {
      grid.innerHTML = '<p class="empty">No books available.</p>';
      return;
    }
    state.books.forEach((b) => {
      const card = document.createElement('article');
      card.className = 'qr-card';
      const holder = document.createElement('div');
      holder.className = 'qr-img';
      card.appendChild(holder);
      card.insertAdjacentHTML('beforeend', `<h3>${escapeHTML(b.title)}</h3><code>${escapeHTML(b.id)}</code>`);
      grid.appendChild(card);
      makeQR(holder, bookPayload(b), 128);
    });
  }

  /* ==========================================================
     K. INIT
     ========================================================== */
  function renderAll() {
    if (!state.user) return;
    if (state.user.role === 'student') {
      renderMyIssues();
    } else {
      renderInventory();
      renderIssues();
      if (state.activeTab === 'qrgrid') renderQRGrid(); // regenerate when books change
    }
  }

  function updateStatusBadge() {
    const connected = !!supabaseClient;
    const badge = $('status-badge');
    badge.textContent = connected ? 'Connected' : 'Offline Demo Mode';
    badge.className = `badge ${connected ? 'badge-success' : 'badge-warning'}`;
  }

  function bindEvents() {
    // Login screen
    document.querySelector('.role-switch').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-role]');
      if (!btn) return;
      authUI.role = btn.dataset.role;
      renderAuthUI();
    });
    $('auth-toggle-mode').addEventListener('click', () => {
      authUI.mode = authUI.mode === 'login' ? 'signup' : 'login';
      renderAuthUI();
    });
    $('auth-form').addEventListener('submit', submitAuth);
    $('logout-btn').addEventListener('click', logout);
    if (supabaseClient) {
      // TODO: SUPABASE – react to sign-out from another tab or an expired session
      supabaseClient.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_OUT' && state.user) exitApp();
      });
    }

    // Student: scanner + manual lookup
    $('start-scan').addEventListener('click', () => startScanner('qr-reader', handleStudentLookup));
    $('stop-scan').addEventListener('click', () => stopScanner('qr-reader'));
    $('lookup-btn').addEventListener('click', () => handleStudentLookup($('manual-id').value));
    $('manual-id').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); handleStudentLookup($('manual-id').value); }
    });
    $('proceed-issue').addEventListener('click', showIssueForm);

    // Student: issue form
    $('issue-date').addEventListener('change', updateReturnDate);
    $('issue-date').addEventListener('input', updateReturnDate);
    $('issue-form').addEventListener('submit', submitIssue);

    // Mark fields as "touched" so :invalid styling only appears after interaction
    document.addEventListener('blur', (e) => {
      if (e.target.matches && e.target.matches('input, select')) e.target.classList.add('touched');
    }, true);

    // Librarian: add book
    $('add-book-form').addEventListener('submit', submitAddBook);
    $('book-category').addEventListener('change', (e) => {
      const custom = e.target.value === '__custom';
      $('custom-category-wrap').classList.toggle('hidden', !custom);
      if (custom) $('book-category-custom').focus();
    });
    $('download-qr').addEventListener('click', downloadQR);

    // Inventory: search, filter, sort, delegated delete
    $('inventory-search').addEventListener('input', debounce(renderInventory, 200));
    $('inventory-category').addEventListener('change', renderInventory);
    $('inventory-sort').addEventListener('change', renderInventory);
    $('inventory-body').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="delete"]');
      if (btn) handleDelete(btn.dataset.id);
    });

    // Librarian: return flow
    $('return-start').addEventListener('click', () => startScanner('return-reader', handleReturnLookup));
    $('return-stop').addEventListener('click', () => stopScanner('return-reader'));
    $('return-lookup').addEventListener('click', () => handleReturnLookup($('return-id').value));
    $('return-id').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); handleReturnLookup($('return-id').value); }
    });
    $('return-confirm-btn').addEventListener('click', confirmReturn);

    // Print
    $('print-btn').addEventListener('click', () => window.print());

    // Release the camera when leaving the page
    window.addEventListener('beforeunload', stopAllScanners);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    setupIssueForm();
    bindNavigation();
    bindEvents();
    updateStatusBadge();
    renderAuthUI();
    try {
      // Restore an existing session (page reload), otherwise stay on the login screen
      const user = await api.auth.getCurrentUser();
      if (user) await enterApp(user);
    } catch (err) {
      console.error(err);
      showToast('Could not check your login session. Please log in again.', 'error');
    }
  });

  /* ==========================================================
     SUPABASE SQL SCHEMA (TODO: SUPABASE)
     The complete, ready-to-run SQL is provided separately as
     supabase_schema.sql. It creates:
       books, issues, profiles (role: 'student' | 'librarian'),
       app_settings (secret librarian_code, never readable from the browser),
       trigger handle_new_user(): new signups become 'librarian' only when the
         supplied access code matches app_settings.librarian_code,
       functions is_librarian(), issue_book(...), return_book(...),
       RLS: students read books + their own issues; only librarians modify
         books and process returns.
     ========================================================== */
})();