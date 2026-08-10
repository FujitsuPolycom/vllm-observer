export function installResumeListeners(documentTarget, windowTarget, resume) {
  const onVisibility = () => { if (!documentTarget.hidden) resume('visibilitychange'); };
  const onPageShow = () => resume('pageshow');
  const onFocus = () => resume('focus');
  documentTarget.addEventListener('visibilitychange', onVisibility);
  windowTarget.addEventListener('pageshow', onPageShow);
  windowTarget.addEventListener('focus', onFocus);
  return () => {
    documentTarget.removeEventListener('visibilitychange', onVisibility);
    windowTarget.removeEventListener('pageshow', onPageShow);
    windowTarget.removeEventListener('focus', onFocus);
  };
}
