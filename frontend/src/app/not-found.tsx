export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6 text-slate-800">
      <div className="text-center">
        <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          404
        </p>
        <h1 className="mt-2 text-2xl font-semibold">Page introuvable</h1>
        <p className="mt-2 text-sm text-slate-600">
          Cette route n’existe pas dans CycleGen.
        </p>
        <a
          href="/"
          className="mt-6 inline-block rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          Retour à l’accueil
        </a>
      </div>
    </main>
  );
}
