'use client';

import { useState } from 'react';

export default function Home() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [focused, setFocused] = useState(false);

  const handleDownload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.includes('studydrive.net')) {
      setError('Please provide a valid StudyDrive URL.');
      return;
    }
    setError('');
    setSuccess(false);
    setLoading(true);

    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) {
        let errorMsg = 'Failed to unlock document.';
        try {
          const contentType = res.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            const errorData = await res.json();
            errorMsg = errorData.error || errorMsg;
          } else {
            const textData = await res.text();
            errorMsg = `Server Error (${res.status}): ${textData.substring(0, 100)}`;
          }
        } catch {
          errorMsg = `Server Error (${res.status}): Failed to parse response.`;
        }
        throw new Error(errorMsg);
      }

      const blob = await res.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;

      const contentDisposition = res.headers.get('content-disposition');
      let filename = 'Unlocked-Document.pdf';
      if (contentDisposition && contentDisposition.includes('filename=')) {
        const matches = /filename="([^"]+)"/.exec(contentDisposition);
        if (matches && matches[1]) {
          filename = matches[1];
        }
      }
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(downloadUrl);

      setSuccess(true);
      setUrl('');

    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An unexpected server error occurred.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-[100dvh] bg-[#0A0A0A] selection:bg-[#fff]/20 selection:text-white flex flex-col items-center justify-center relative overflow-hidden font-sans">

      {/* Refined Ambient Background Patterns */}
      <div className="absolute inset-0 z-0">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-gradient-radial from-[rgba(45,45,45,0.4)] to-transparent rounded-full blur-3xl opacity-50 mix-blend-screen" />
      </div>

      <div className="absolute inset-0 bg-[#0A0A0A]/40 backdrop-blur-[100px] z-0" />
      <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-[0.03] z-0 mix-blend-overlay pointer-events-none" />

      {/* Main Content Area */}
      <div className="relative z-10 w-full max-w-[540px] px-6 py-12 flex flex-col gap-8">

        {/* Header Section */}
        <header className="flex flex-col gap-3 text-center sm:text-left">
          <div className="inline-flex items-center gap-2 text-xs font-semibold tracking-wider uppercase text-[#888] mb-2 sm:mb-0">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Server Status: Online
          </div>
          <h1 className="text-4xl sm:text-5xl lg:text-5xl font-semibold text-[#FAFAFA] tracking-[-0.03em] leading-tight">
            StudyDrive <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#888] to-[#444]">Bypass</span>
          </h1>
          {/*   <p className="text-[15px] sm:text-base text-[#888] leading-relaxed max-w-[420px]">
            Extract requested study materials cleanly and anonymously. No account required.
          </p> */}
        </header>

        {/* Action Panel */}
        <div className="relative flex flex-col gap-4">
          <form onSubmit={handleDownload} className="relative w-full group">
            {/* Input Wrapper holding the subtle glow */}
            <div className={`relative w-full rounded-[14px] bg-[#111] transition-all duration-300 ${focused ? 'ring-1 ring-[#333] shadow-[0_0_40px_-15px_rgba(255,255,255,0.1)]' : 'ring-1 ring-[#222]'}`}>
              <div className="flex items-center h-[60px] px-4">
                <svg className={`w-5 h-5 shrink-0 transition-colors duration-300 ${focused ? 'text-[#FAFAFA]' : 'text-[#555]'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
                <input
                  type="url"
                  required
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  placeholder="Paste studydrive link here..."
                  className="w-full bg-transparent border-none outline-none text-[15px] text-[#FAFAFA] placeholder-[#555] px-3 h-full font-medium"
                  disabled={loading}
                />

                {/* Embedded Button for larger screens */}
                <div className="hidden sm:block absolute right-2">
                  <button
                    type="submit"
                    disabled={loading || !url}
                    className={`h-[44px] px-6 rounded-[10px] text-sm font-medium transition-all duration-300 flex items-center justify-center
                        ${loading || !url
                        ? 'bg-[#1A1A1A] text-[#555] cursor-not-allowed'
                        : 'bg-[#FAFAFA] text-[#0A0A0A] hover:bg-[#EAEAEA] active:scale-[0.98]'}`}
                  >
                    {loading ? (
                      <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 bg-[#555] rounded-full animate-bounce [animation-delay:-0.3s]" />
                        <div className="w-1.5 h-1.5 bg-[#555] rounded-full animate-bounce [animation-delay:-0.15s]" />
                        <div className="w-1.5 h-1.5 bg-[#555] rounded-full animate-bounce" />
                      </div>
                    ) : 'Extract'}
                  </button>
                </div>
              </div>
            </div>

            {/* External Button for mobile screens */}
            <button
              type="submit"
              disabled={loading || !url}
              className={`sm:hidden mt-4 w-full h-[54px] rounded-[12px] text-[15px] font-semibold transition-all duration-300 flex items-center justify-center
                  ${loading || !url
                  ? 'bg-[#111] ring-1 ring-[#222] text-[#555] cursor-not-allowed'
                  : 'bg-[#FAFAFA] text-[#0A0A0A] active:scale-[0.98] shadow-lg'}`}
            >
              {loading ? 'Processing Protocol...' : 'Extract Document'}
            </button>
          </form>

          {/* Status Messages */}
          <div className="min-h-[48px]">
            {error && (
              <div className="w-full bg-[#1A0A0A] ring-1 ring-red-900/50 rounded-[12px] p-3 text-red-500/90 text-sm font-medium animate-in fade-in slide-in-from-top-2 flex items-center gap-3">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                {error}
              </div>
            )}

            {success && (
              <div className="w-full bg-[#0A1A10] ring-1 ring-emerald-900/50 rounded-[12px] p-3 text-emerald-500/90 text-sm font-medium animate-in fade-in slide-in-from-top-2 flex items-center gap-3">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg>
                Extraction successful. Local download initiated.
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="mt-8 flex flex-col items-center gap-2 text-[#666] text-[13px] relative z-20">
          <p>
            Designed and powered by {' '}
            <a href="https://alaash.de" target="_blank" rel="noopener noreferrer" className="text-[#888] hover:text-[#FAFAFA] transition-colors underline underline-offset-4 decoration-[#333] hover:decoration-[#666]">
              alaash.de
            </a>
          </p>
        </div>

      </div>
    </main>
  );
}
