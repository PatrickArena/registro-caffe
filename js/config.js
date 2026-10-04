/* Configurazione del Registro del Caffe'.
 *
 * Finche' i due campi Supabase restano vuoti l'app funziona in locale:
 * i dati stanno solo su questo dispositivo, nessuna rete, nessun account.
 *
 * Per condividere il registro fra piu' telefoni: segui il README, poi incolla
 * qui l'URL del progetto e la chiave "anon public". Nient'altro da toccare.
 */
window.REGISTRO_CONFIG = {
  supabaseUrl: "https://cvadnccocxdyuzsvmywb.supabase.co",

  // La chiave PUBBLICA del progetto, mai la "service_role" / "secret".
  // Vanno bene entrambe le forme che Supabase ha usato nel tempo:
  //   sb_publishable_...  (attuale)
  //   eyJ...              ("anon public", storica)
  // store.js distingue le due: solo la seconda e' un JWT e va anche in Bearer.
  supabaseAnonKey: "sb_publishable_ZskHhwGTrmO9Evs6_czkjA_LZywUW5y",

  // La stanza dell'ufficio: chi apre l'indirizzo dell'app, senza codice e senza
  // averla mai aperta prima, entra qui. Senza questo campo ogni dispositivo si
  // creerebbe una stanza propria e i registri resterebbero separati — che e'
  // esattamente l'errore in cui siamo caduti il 30 agosto 2026.
  // Chi vuole un registro separato usa comunque il link con #r=<codice>.
  defaultRoom: "gmco2fvtxoy8ji",

  // Ogni quanti secondi ricontrollare se i colleghi hanno registrato un giro.
  pollSeconds: 5

  // I compleanni stanno nel database (colonna people.birthday, "GG/MM") e si
  // inseriscono dall'app toccando un nome: niente da scrivere qui.
};
