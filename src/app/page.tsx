import CsvUploader from '@/components/CsvUploader';

export default function Home() {
  return (
    <main className="min-h-screen p-8">
      <h1 className="text-3xl font-bold mb-8">Kalshi Dashboard</h1>
      <CsvUploader />
    </main>
  );
}
