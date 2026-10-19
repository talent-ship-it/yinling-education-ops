export const styles = `
.ilct{font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif;color:#f3f4f4;font-size:14px;line-height:1.5;color-scheme:dark}
.ilct *{box-sizing:border-box}
.ilct-panel{width:340px;max-width:calc(100vw - 32px);background:#303234;border:1px solid #535658;border-radius:8px;box-shadow:0 12px 36px #0006;overflow:hidden}
.ilct-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #494c4e;font-size:14px;font-weight:500;cursor:default}
.ilct button,.ilct input{font:inherit}
.ilct button{cursor:pointer;border:0;border-radius:4px;color:#fff;background:#505456;min-height:36px;padding:6px 14px}
.ilct button:disabled{opacity:.45;cursor:not-allowed}
.ilct button:focus-visible,.ilct input:focus-visible{outline:2px solid #f3c552;outline-offset:3px}
.ilct .ilct-close{min-height:28px;width:28px;padding:0;color:#d2d5d6;background:transparent;font-size:22px;line-height:1}
.ilct-body{padding:18px}
.ilct-label{display:block;color:#c9cdcf;font-size:12px;margin-bottom:6px}
.ilct input{width:100%;border:1px solid #696e70;border-radius:4px;background:#4e5254;color:white;padding:8px 10px;min-height:38px}
.ilct-preview{display:block;margin:16px 0;width:100%;height:150px;object-fit:contain;background:#fff;border:1px solid #707477}
.ilct-filetype{margin:14px 0;color:#dce0e0;font-size:13px;display:flex;align-items:center;gap:8px}
.ilct-filetype-mark{display:inline-grid;place-items:center;width:17px;height:17px;border-radius:3px;background:#00ad87;color:white;font-size:12px}
.ilct-footer{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}
.ilct button.ilct-primary{background:#00aa84;color:#fff}
.ilct button.ilct-primary:hover:not(:disabled){background:#00bd94}
.ilct button.ilct-secondary:hover:not(:disabled){background:#616668}
.ilct-error{font-size:13px;color:#ffd9c3;margin:12px 0 0;overflow-wrap:anywhere}
.ilct-status{margin:18px 0;color:#d2d7d7;font-size:13px}
.ilct-digits{display:flex;align-items:center;justify-content:center;gap:5px;margin:0 0 12px}
.ilct-digit{width:52px;display:flex;flex-direction:column;align-items:center;gap:2px}
.ilct-digit output{font-family:"Arial Narrow",Arial,sans-serif;font-variant-numeric:tabular-nums;font-size:60px;line-height:1.15;font-weight:300;width:100%;text-align:center;background:#252729;border:1px solid #484c4f;border-radius:3px;color:#eff2f2;text-shadow:0 1px #000}
.ilct .ilct-arrow{background:transparent;min-height:24px;width:100%;padding:0;color:#afb5b7;font-size:17px}
.ilct .ilct-arrow:hover:not(:disabled){color:#fff;background:#44484a}
.ilct-colon{font-size:50px;color:#c8cecf;padding-bottom:5px;line-height:1}
.ilct-timer-actions{display:flex;gap:8px}
.ilct-timer-actions button:first-child{flex:1}
.ilct-readonly{font-variant-numeric:tabular-nums;text-align:center;font-size:56px;line-height:1.4;letter-spacing:4px;font-weight:300}
.ilct-caption{text-align:center;color:#c4cccc;font-size:12px;margin:0 0 12px}
.ilct-off{width:100%;margin-top:10px;font-size:12px!important;background:transparent!important;color:#c6cccc!important;min-height:30px!important}
.ilct-focus-notice{width:340px;max-width:calc(100vw - 32px);margin-top:10px;padding:14px;background:#303234;border:1px solid #535658;border-radius:8px;box-shadow:0 8px 24px #0005}\n.ilct-focus-notice .ilct-close{float:right}\n.ilct-focus-notice p{margin:0 24px 12px 0;overflow-wrap:anywhere}\n@media(max-width:480px){.ilct-panel{width:300px}.ilct-digit{width:45px}.ilct-digit output{font-size:54px}.ilct-body{padding:16px}}
`;
