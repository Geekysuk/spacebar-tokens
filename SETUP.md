# Spacebar tokens — setup

Completely separate from Pinky's Ledger: its own Firebase project, its own GitHub repo, its own address.

Two pages:
- `/` (staff.spacebararcade.co.uk) — the QR page staff use. Machine code + staff code → token count → tested OK / something's wrong.
- `/admin.html` — Rob only. Overview rankings, every empty, faults, weekly sold-vs-collected check, machines, staff codes, sticker printing.

## 1. Firebase (new project)
1. console.firebase.google.com → Add project → name it `spacebar-tokens`, Analytics off.
2. Build → Authentication → Get started → Sign-in method → Email/Password → Enable.
3. Authentication → Users → Add user → your email + a strong password. Copy the **User UID**.
4. Authentication → Settings → User actions: turn on "Email enumeration protection"; leave "Enable create (sign-up)" off.
   (Extra accounts wouldn't get anything anyway — the rules only trust your UID.)
5. Build → Firestore Database → Create database → Production mode → location `europe-west2` (London).
6. Firestore → Rules → paste `firestore.rules`, replacing `PASTE_ROB_UID` with the UID from step 3 → Publish.
7. Project settings (cog) → Your apps → `</>` Web → nickname `tokens web`, no hosting → copy the `firebaseConfig` block into `js/config.js`.
8. Authentication → Settings → Authorized domains → add `staff.spacebararcade.co.uk` (and `geekysuk.github.io` if you'll test there first).

## 2. GitHub Pages
1. github.com/new → repo `spacebar-tokens` (public), no README.
2. Upload everything in this folder (keep the folder structure: `assets/`, `css/`, `js/`, plus `CNAME` and `.nojekyll`).
3. Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)` → Save.
4. Custom domain: `staff.spacebararcade.co.uk` → Save → tick Enforce HTTPS once the DNS check passes.

## 3. IONOS DNS (spacebararcade.co.uk)
Add a CNAME record: host `staff` → `geekysuk.github.io`. Give it 10–30 minutes.

## 4. Lock the API key (optional, same as Pinky's)
console.cloud.google.com → APIs & Services → Credentials → the "Browser key (auto created by Firebase)" → Application restrictions: Websites → add `staff.spacebararcade.co.uk/*` → Save.

## 5. First use
1. Open https://staff.spacebararcade.co.uk/admin.html → sign in.
2. Machines → add: Mario Kart, Ridge Racer, Wild Riders, Big Buck Hunter, TC2, Street Fighter (codes 1001–1006 are suggested automatically).
3. Staff codes → add one per person. Write the code down when you add it — it's stored hashed and can't be shown again.
4. Print QR → pick a machine → Print (50 × 68 mm, same size as the Pinky's stickers).
5. Weekly check → type the tokens sold each week (Mon–Sun); collected comes from staff empties.

## Notes
- Machines are keyed by their 4-digit code, so the code can't change after creation. Turn a machine off rather than deleting it.
- Staff codes are SHA-256 hashed doc IDs; the rules check the hash exists and is active before accepting an empty.
- The shared QR (`assets/qr.svg`) points at https://staff.spacebararcade.co.uk/. If the address ever changes, regenerate it.
- Admin auto signs out after 30 minutes idle.
- To change things later: edit the files, re-upload to the repo. No build step.
