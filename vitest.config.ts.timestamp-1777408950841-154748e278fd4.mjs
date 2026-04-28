import "node:module";
import { defineConfig } from "vitest/config";
import.meta.url;
var vitest_config_default = defineConfig({ test: {
	include: ["test/**/*.test.ts"],
	environment: "node",
	coverage: {
		provider: "v8",
		reporter: ["text", "html"],
		include: ["src/**/*.ts"]
	}
} });
//#endregion
export { vitest_config_default as default };

//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidml0ZXN0LmNvbmZpZy5qcyIsIm5hbWVzIjpbXSwic291cmNlcyI6WyIvc2Vzc2lvbnMvY2xldmVyLXdvbmRlcmZ1bC1zaGFubm9uL21udC9UYWNvQmVsbC9kYXNoMC1sYW1iZGEtY2xpL3ZpdGVzdC5jb25maWcudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSBcInZpdGVzdC9jb25maWdcIjtcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcbiAgdGVzdDoge1xuICAgIGluY2x1ZGU6IFtcInRlc3QvKiovKi50ZXN0LnRzXCJdLFxuICAgIGVudmlyb25tZW50OiBcIm5vZGVcIixcbiAgICBjb3ZlcmFnZToge1xuICAgICAgcHJvdmlkZXI6IFwidjhcIixcbiAgICAgIHJlcG9ydGVyOiBbXCJ0ZXh0XCIsIFwiaHRtbFwiXSxcbiAgICAgIGluY2x1ZGU6IFtcInNyYy8qKi8qLnRzXCJdLFxuICAgIH0sXG4gIH0sXG59KTtcbiJdLCJtYXBwaW5ncyI6Ijs7O0FBRUEsSUFBQSx3QkFBZSxhQUFhLEVBQzFCLE1BQU07Q0FDSixTQUFTLENBQUMsb0JBQW9CO0NBQzlCLGFBQWE7Q0FDYixVQUFVO0VBQ1IsVUFBVTtFQUNWLFVBQVUsQ0FBQyxRQUFRLE9BQU87RUFDMUIsU0FBUyxDQUFDLGNBQWM7RUFDekI7Q0FDRixFQUNGLENBQUMifQ==